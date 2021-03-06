/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * Docker Registry API v2 client. See the README for an intro.
 *
 * <https://docs.docker.com/registry/spec/api/>
 */

var assert = require('assert-plus');
var base64url = require('base64url');
var bunyan = require('bunyan');
var crypto = require('crypto');
var fmt = require('util').format;
var jwkToPem = require('jwk-to-pem');
var mod_jws = require('jws');
var querystring = require('querystring');
var restify = require('restify');
var strsplit = require('strsplit');
var mod_url = require('url');
var vasync = require('vasync');

var common = require('./common');
var DockerJsonClient = require('./docker-json-client');
var errors = require('./errors');


// --- Globals

// https://github.com/docker/docker/blob/77da5d8/registry/config_unix.go#L10
var DEFAULT_V2_REGISTRY = 'https://registry-1.docker.io';



// --- internal support functions


function _createLogger(log) {
    assert.optionalObject(log, 'log');

    if (log) {
        // TODO avoid this .child if already have the serializers, e.g. for
        // recursive call.
        return log.child({
            serializers: restify.bunyan.serializers
        });
    } else {
        return bunyan.createLogger({
            name: 'registry',
            serializers: restify.bunyan.serializers
        });
    }
}


function _basicAuthHeader(username, password) {
    var buffer = new Buffer(username + ':' + password, 'utf8');
    return 'Basic ' + buffer.toString('base64');
}


/*
 * Return an appropriate "Authorization" HTTP header for the given auth info.
 * - Bearer auth if `token`.
 * - Else, Basic auth if `username` and `password`.
 * - Else, undefined
 */
function _authHeaderFromAuthInfo(authInfo) {
    if (authInfo.token) {
        return 'Bearer ' + authInfo.token;
    } else if (authInfo.username && authInfo.password) {
        return _basicAuthHeader(authInfo.username, authInfo.password);
    } else {
        return undefined;
    }
}

/**
 * XXX still true for v2?
 *
 * Special handling of errors from the registry server.
 *
 * When some of the endpoints get a 404, the response body is a largish dump
 * of test/html. We don't want to include that as an error "message". It
 * isn't useful.
 *
 * Usage:
 *      cb(new _sanitizeErr(err, req, res[, errmsg]));
 *
 * where `errmsg` is an optional fallback error message to use for the
 * sanitized 404 err.message.
 */
function _sanitizeErr(err, req, res, errmsg) {
    if (err.statusCode === 404 && res && res.headers['content-type'] &&
        res.headers['content-type'].split(';')[0] !== 'application/json')
    {
        err.message = errmsg || 'not found';
    }
    return err;
}

/**
 * Parse a WWW-Authenticate header like this:
 *
 *      // JSSTYLED
 *      www-authenticate: Bearer realm="https://auth.docker.io/token",service="registry.docker.io"
 *      www-authenticate: Basic realm="registry456.example.com"
 *
 * into an object like this:
 *
 *      {
 *          scheme: 'Bearer',
 *          parms: {
 *              realm: 'https://auth.docker.io/token',
 *              service: 'registry.docker.io'
 *          }
 *      }
 *
 * Note: This doesn't handle *multiple* challenges. I've not seen a concrete
 * example of that.
 */
function _parseWWWAuthenticate(header) {
    var parsers = require('www-authenticate/lib/parsers');
    var parsed = new parsers.WWW_Authenticate(header);
    if (parsed.err) {
        throw new Error('could not parse WWW-Authenticate header "' + header
            + '": ' + parsed.err);
    }
    return parsed;
}


/**
 * Get an auth token.
 *
 * See: docker/docker.git:registry/token.go
 */
function _getToken(opts, cb) {
    assert.string(opts.indexName, 'opts.indexName'); // used for error messages
    assert.string(opts.realm, 'opts.realm');
    assert.optionalString(opts.service, 'opts.service');
    assert.optionalArrayOfString(opts.scopes, 'opts.scopes');
    assert.optionalString(opts.username, 'opts.username');
    assert.optionalString(opts.password, 'opts.password');
    // HTTP client opts:
    assert.object(opts.log, 'opts.log');
    assert.optionalObject(opts.agent, 'opts.agent');
    // assert.optional object or bool(opts.proxy, 'opts.proxy');
    assert.optionalBool(opts.insecure, 'opts.insecure');
    assert.optionalString(opts.userAgent, 'opts.userAgent');
    var log = opts.log;

    // - add https:// prefix (or http) if none on 'realm'
    var tokenUrl = opts.realm;
    var match = /^(\w+):\/\//.exec(tokenUrl);
    if (!match) {
        tokenUrl = (opts.insecure ? 'http' : 'https') + '://' + tokenUrl;
    } else if (['http', 'https'].indexOf(match[1]) === -1) {
        return cb(new Error(fmt('unsupported scheme for ' +
            'WWW-Authenticate realm "%s": "%s"', opts.realm, match[1])));
    }

    // - GET $realm
    //      ?service=$service
    //      (&scope=$scope)*
    //      (&account=$username)
    //   Authorization: Basic ...
    var headers = {};
    var query = {};
    if (opts.service) {
        query.service = opts.service;
    }
    if (opts.scopes && opts.scopes.length) {
        query.scope = opts.scopes;  // intentionally singular 'scope'
    }

    if (opts.username) {
        query.account = opts.username;
    }
    if (opts.username && opts.password) {
        headers.authorization = _basicAuthHeader(opts.username,
            opts.password);
    }
    if (Object.keys(query).length) {
        tokenUrl += '?' + querystring.stringify(query);
    }
    log.trace({tokenUrl: tokenUrl}, '_getToken: url');

    var parsedUrl = mod_url.parse(tokenUrl);
    var client = new DockerJsonClient({
        url: parsedUrl.protocol + '//' + parsedUrl.host,
        log: log,
        agent: opts.agent,
        proxy: opts.proxy,
        rejectUnauthorized: !opts.insecure,
        userAgent: opts.userAgent || common.DEFAULT_USERAGENT
    });
    client.get({
        path: parsedUrl.path,
        headers: headers
    }, function (err, req, res, body) {
        client.close();
        if (err) {
            return cb(new errors.UnauthorizedError(err,
                'token auth attempt for %s: %s request failed with status %s',
                opts.indexName, tokenUrl, (res ? res.statusCode : '???')));
        } else if (!body.token) {
            return cb(new errors.UnauthorizedError(err, 'authorization ' +
                'server did not include a token in the response'));
        }
        cb(null, body.token);
    });
}


/* BEGIN JSSTYLED */
/*
 * Parse out a JWS (JSON Web Signature) from the given Docker manifest
 * endpoint response. This JWS is used for both 'Docker-Content-Digest' header
 * verification and JWS signing verification.
 *
 * This mimicks:
 *      func ParsePrettySignature(content []byte, signatureKey string)
 *          (*JSONSignature, error)
 * in "docker/vendor/src/github.com/docker/libtrust/jsonsign.go"
 *
 * @returns {Object} JWS object with 'payload' and 'signatures' fields.
 * @throws {InvalidContentError} if there is a problem parsing the manifest
 *      body.
 *
 *
 * # Design
 *
 * tl;dr: Per <https://docs.docker.com/registry/spec/api/#digest-header>
 * the payload used for the digest is a little obtuse for the getManifest
 * endpoint: It is the raw JSON body (the raw content because indentation
 * and key order matters) minus the "signatures" key. The "signatures"
 * key is always the last one. The byte offset at which to strip and a
 * suffix to append is included in the JWS "protected" header.
 *
 *
 * A longer explanation:
 *
 * Let's use the following (clipped for clarity) sample getManifest
 * request/response to a Docker v2 Registry API (in this case Docker Hub):
 *
 *     GET /v2/library/alpine/manifests/latest HTTP/1.1
 *     ...
 *
 *     HTTP/1.1 200 OK
 *     docker-content-digest: sha256:08a98db12e...fe0d
 *     ...
 *
 *     {
 *         "schemaVersion": 1,
 *         "name": "library/alpine",
 *         "tag": "latest",
 *         "architecture": "amd64",
 *         "fsLayers": [
 *             {
 *                 "blobSum": "sha256:c862d82a67...d58"
 *             }
 *         ],
 *         "history": [
 *             {
 *                 "v1Compatibility": "{\"id\":\"31f6...4492}\n"
 *             }
 *         ],
 *         "signatures": [
 *             {
 *                 "header": {
 *                     "jwk": {
 *                         "crv": "P-256",
 *                         "kid": "OIH7:HQFS:44FK:45VB:3B53:OIAG:TPL4:ATF5:6PNE:MGHN:NHQX:2GE4",
 *                         "kty": "EC",
 *                         "x": "Cu_UyxwLgHzE9rvlYSmvVdqYCXY42E9eNhBb0xNv0SQ",
 *                         "y": "zUsjWJkeKQ5tv7S-hl1Tg71cd-CqnrtiiLxSi6N_yc8"
 *                     },
 *                     "alg": "ES256"
 *                 },
 *                 "signature": "JV1F_gXAsUEp_e2WswSdHjvI0veC-f6EEYuYJZhgIPpN-LQ5-IBSOX7Ayq1gv1m2cjqPy3iXYc2HeYgCQTxM-Q",
 *                 "protected": "eyJmb3JtYXRMZW5ndGgiOjE2NzUsImZvcm1hdFRhaWwiOiJDbjAiLCJ0aW1lIjoiMjAxNS0wOS0xMFQyMzoyODowNloifQ"
 *             }
 *         ]
 *     }
 *
 *
 * We will be talking about specs from the IETF JavaScript Object Signing
 * and Encryption (JOSE) working group
 * <https://datatracker.ietf.org/wg/jose/documents/>. The relevant ones
 * with Docker registry v2 (a.k.a. docker/distribution) are:
 *
 * 1. JSON Web Signature (JWS): https://tools.ietf.org/html/rfc7515
 * 2. JSON Web Key (JWK): https://tools.ietf.org/html/rfc7517
 *
 *
 * Docker calls the "signatures" value the "JWS", a JSON Web Signature.
 * That's mostly accurate. A JWS, using the JSON serialization that
 * Docker is using, looks like:
 *
 *      {
 *          "payload": "<base64url-encoded payload bytes>",
 *          "signatures": [
 *              {
 *                  "signature": "<base64url-encoded signature>",
 *                  // One or both of "protected" and "header" must be
 *                  // included, and an "alg" key (the signing algoritm)
 *                  // must be in one of them.
 *                  "protected": "<base64url-encoded header key/value pairs
 *                      included in the signature>",
 *                  "header": {
 *                      <key/value pairs *not* included in the signature>
 *                   }
 *              }
 *          ]
 *      }
 *
 * (I'm eliding some details: If there is only one signature, then the
 * signature/protected/et al fields can be raised to the top-level. There
 * is a "compact" serialization that we don't need to worry about,
 * other than most node.js JWS modules don't directly support the JSON
 * serialization. There are other optional signature fields.)
 *
 * I said "mostly accurate", because the "payload" is missing. Docker
 * flips the JWS inside out, so that the "signatures" are include *in
 * the payload*. The "protected" header provides some data needed to
 * tease the signing payload out of the HTTP response body. Using our
 * example:
 *
 *      $ echo eyJmb3JtYXRMZW5ndGgiOjE2NzUsImZvcm1hdFRhaWwiOiJDbjAiLCJ0aW1lIjoiMjAxNS0wOS0xMFQyMzoyODowNloifQ | ./node_modules/.bin/base64url --decode
 *      {"formatLength":1675,"formatTail":"Cn0","time":"2015-09-10T23:28:06Z"}
 *
 * Here "formatLength" is a byte count into the response body to extract
 * and "formatTail" is a base64url-encoded suffix to append to that. In
 * practice the "formatLength" is up to comma before the "signatures" key
 * and "formatLength" is:
 *
 *      > base64url.decode('Cn0')
 *      '\n}'
 *
 * Meaning the signing payload is typically the equivalent of
 * `delete body["signatures"]`:
 *
 *      {
 *         "schemaVersion": 1,
 *         "name": "library/alpine",
 *         "tag": "latest",
 *         "architecture": "amd64",
 *         "fsLayers": ...,
 *         "history": ...
 *      }
 *
 * However, whitespace is significant because we are just signing bytes,
 * so the raw response body must be manipulated. An odd factoid is that
 * docker/libtrust seems to default to 3-space indentation:
 * <https://github.com/docker/libtrust/blob/9cbd2a1374f46905c68a4eb3694a130610adc62a/jsonsign.go#L450>
 * Perhaps to avoid people getting lucky.
 *
 */
/* END JSSTYLED */
function _jwsFromManifest(manifest, body) {
    assert.object(manifest, 'manifest');
    assert.buffer(body, 'body');

    var formatLength;
    var formatTail;
    var jws = {
        signatures: []
    };

    for (var i = 0; i < manifest.signatures.length; i++) {
        var sig = manifest.signatures[i];

        try {
            var protectedHeader = JSON.parse(
                base64url.decode(sig['protected']));
        } catch (protectedErr) {
            throw new restify.InvalidContentError(protectedErr, fmt(
                'could not parse manifest "signatures[%d].protected": %j',
                i, sig['protected']));
        }
        if (isNaN(protectedHeader.formatLength)) {
            throw new restify.InvalidContentError(fmt(
                'invalid "formatLength" in "signatures[%d].protected": %j',
                i, protectedHeader.formatLength));
        } else if (formatLength === undefined) {
            formatLength = protectedHeader.formatLength;
        } else if (protectedHeader.formatLength !== formatLength) {
            throw new restify.InvalidContentError(fmt(
                'conflicting "formatLength" in "signatures[%d].protected": %j',
                i, protectedHeader.formatLength));
        }

        if (!protectedHeader.formatTail ||
            typeof (protectedHeader.formatTail) !== 'string')
        {
            throw new restify.InvalidContentError(fmt(
                'missing "formatTail" in "signatures[%d].protected"', i));
        }
        var formatTail_ = base64url.decode(protectedHeader.formatTail);
        if (formatTail === undefined) {
            formatTail = formatTail_;
        } else if (formatTail_ !== formatTail) {
            throw new restify.InvalidContentError(fmt(
                'conflicting "formatTail" in "signatures[%d].protected": %j',
                i, formatTail_));
        }

        var jwsSig = {
            header: {
                alg: sig.header.alg,
                chain: sig.header.chain
            },
            signature: sig.signature,
            'protected': sig['protected']
        };
        if (sig.header.jwk) {
            try {
                jwsSig.header.jwk = jwkToPem(sig.header.jwk);
            } catch (jwkErr) {
                throw new restify.InvalidContentError(jwkErr, fmt(
                    'error in "signatures[%d].header.jwk": %s',
                    i, jwkErr.message));
            }
        }
        jws.signatures.push(jwsSig);
    }

    jws.payload = Buffer.concat([
        body.slice(0, formatLength),
        new Buffer(formatTail)
    ]);

    return jws;
}


/*
 * Parse the 'Docker-Content-Digest' header.
 *
 * @throws {BadDigestError} if the value is missing or malformed
 * @returns ...
 */
function _parseDockerContentDigest(dcd) {
    if (!dcd) {
        throw new restify.BadDigestError(
            'missing "Docker-Content-Digest" header');
    }

    // E.g. docker-content-digest: sha256:887f7ecfd0bda3...
    var parts = strsplit(dcd, ':', 2);
    if (parts.length !== 2) {
        throw new restify.BadDigestError(
            'could not parse "Docker-Content-Digest" header: ' + dcd);
    }

    var hash;
    try {
        hash = crypto.createHash(parts[0]);
    } catch (hashErr) {
        throw new restify.BadDigestError(hashErr, fmt(
            '"Docker-Content-Digest" header error: %s: %s',
            hashErr.message, dcd));
    }
    var expectedDigest = parts[1];

    return {
        raw: dcd,
        hash: hash,
        algorithm: parts[0],
        expectedDigest: expectedDigest
    };
}

/*
 * Verify the 'Docker-Content-Digest' header for a getManifest response.
 *
 * @throws {BadDigestError} if the digest doesn't check out.
 */
function _verifyManifestDockerContentDigest(res, jws) {
    var dcdInfo = _parseDockerContentDigest(
        res.headers['docker-content-digest']);

    dcdInfo.hash.update(jws.payload);
    var digest = dcdInfo.hash.digest('hex');
    if (dcdInfo.expectedDigest !== digest) {
        res.log.trace({expectedDigest: dcdInfo.expectedDigest,
            header: dcdInfo.raw, digest: digest},
            'Docker-Content-Digest failure');
        throw new restify.BadDigestError('Docker-Content-Digest');
    }
}


/*
 * Verify a manifest JWS (JSON Web Signature)
 *
 * This mimicks
 *      func Verify(sm *SignedManifest) ([]libtrust.PublicKey, error)
 * in "docker/vendor/src/github.com/docker/distribution/manifest/verify.go"
 * which calls
 *      func (js *JSONSignature) Verify() ([]PublicKey, error)
 * in "docker/vendor/src/github.com/docker/libtrust/jsonsign.go"
 *
 * TODO: find an example with `signatures.*.header.chain` to test that path
 *
 * @param jws {Object} A JWS object parsed from `_jwsFromManifest`.
 * @throws {errors.ManifestVerificationError} if there is a problem.
 */
function _verifyJws(jws) {
    var encodedPayload = base64url(jws.payload);

    /*
     * Disallow the "none" algorithm because while the `jws` module might have
     * a guard against
     *      // JSSTYLED
     *      https://auth0.com/blog/2015/03/31/critical-vulnerabilities-in-json-web-token-libraries/
     * why bother allowing it?
     */
    var disallowedAlgs = ['none'];

    for (var i = 0; i < jws.signatures.length; i++) {
        var jwsSig = jws.signatures[i];
        var alg = jwsSig.header.alg;
        if (disallowedAlgs.indexOf(alg) !== -1) {
            throw new errors.ManifestVerificationError(
                {jws: jws, i: i}, 'disallowed JWS signature algorithm:', alg);
        }

        // TODO: Find Docker manifest example using 'header.chain'
        // and implement this. See "jsonsign.go#Verify".
        if (jwsSig.header.chain) {
            throw new errors.InternalError({jws: jws, i: i},
                'JWS verification with a cert "chain" is not implemented: %j',
                jwsSig.header.chain);
        }

        // `mod_jws.verify` takes the JWS compact representation.
        var jwsCompact = jwsSig['protected'] + '.' + encodedPayload +
            '.' + jwsSig.signature;
        var verified = mod_jws.verify(jwsCompact, alg, jwsSig.header.jwk);
        if (!verified) {
            throw new errors.ManifestVerificationError(
                {jws: jws, i: i}, 'JWS signature %d failed verification', i);
        }
    }
}


// --- other exports

/**
 * Ping the base URL.
 * See: <https://docs.docker.com/registry/spec/api/#base>
 *
 * @param opts {Object} Required members are listed first.
 *      - opts.index {String|Object} Required. One of an index *name* (e.g.
 *        "docker.io", "quay.io") that `parseIndex` will handle, an index
 *        *url* (e.g. the default from `docker login` is
 *        'https://index.docker.io/v1/'), or an index *object* as returned by
 *        `parseIndex`. For backward compatibility, `opts.indexName` may be
 *        used instead of `opts.index`.
 *      --
 *      - opts.log {Bunyan Logger} Optional.
 *      - opts.username {String} Optional. Set this and `opts.password` for
 *        Basic auth.
 *      - opts.password {String} Optional, but required if `opts.username` is
 *        provided.
 *      - opts.authInfo {Object} Optional. This is an auth object result
 *        from the top-level `login` (a.k.a.
 *        `require('docker-registry-client').loginV2()`.)
 *      --
 *      TODO: document other options
 * @param cb {Function} `function (err, body, res, req)`
 *      `err` is set if there was a problem getting a ping response. `res` is
 *      the response object. Use `res.statusCode` to infer information:
 *          404     This registry URL does not support the v2 API.
 *          401     Authentication is required (or failed). Use the
 *                  WWW-Authenticate header for the appropriate auth method.
 *                  This `res` can be passed to `login()` to handle
 *                  authenticating.
 *          200     Successful authentication. The response body is `body`
 *                  if wanted.
 */
function ping(opts, cb) {
    assert.func(cb, 'cb');
    assert.object(opts, 'opts');
    assert.ok(opts.index || opts.indexName,
        'opts.index or opts.indexName is required');
    assert.optionalObject(opts.log, 'opts.log');
    // Auth options:
    assert.optionalString(opts.username, 'opts.username');
    if (opts.username) {
        assert.string(opts.password,
            'opts.password required if username given');
    } else {
        assert.optionalString(opts.password, 'opts.password');
    }
    assert.optionalObject(opts.authInfo, 'opts.authInfo');
    // HTTP client basic options:
    assert.optionalBool(opts.insecure, 'opts.insecure');
    assert.optionalBool(opts.rejectUnauthorized, 'opts.rejectUnauthorized');
    assert.optionalString(opts.userAgent, 'opts.userAgent');
    assert.optionalObject(opts.agent, 'opts.agent');
    // assert.optional object or bool(opts.proxy, 'opts.proxy');

    var index = opts.index || opts.indexName;
    if (typeof(index) === 'string') {
        try {
            var index = common.parseIndex(index);
        } catch (indexNameErr) {
            cb(indexNameErr);
            return;
        }
    } else {
        assert.object(index, 'opts.index');
    }

    var log = _createLogger(opts.log);
    log.trace({index: index, username: opts.username,
        password: (opts.password ? '(censored)' : '(none)'),
        scope: opts.scope, insecure: opts.insecure}, 'ping');

    /*
     * We have to special case usage of the "official" docker.io to
     *      https://registry-1.docker.io
     * because:
     *      GET /v2/ HTTP/1.1
     *      Host: index.docker.io
     *
     *      HTTP/1.1 301 Moved Permanently
     *      location: https://registry.hub.docker.com/v2/
     * and:
     *      $ curl -i https://registry.hub.docker.com/v2/
     *      HTTP/1.1 404 NOT FOUND
     */
    var registryUrl;
    if (index.official) {
        registryUrl = DEFAULT_V2_REGISTRY;
    } else {
        registryUrl = common.urlFromIndex(index);
    }

    /*
     * We allow either opts.rejectUnauthorized (for passed in http client
     * options where `insecure` -> `rejectUnauthorized` translation has
     * already been done) or opts.insecure (this module's chosen name
     * for this thing).
     */
    var rejectUnauthorized;
    if (opts.insecure !== undefined && opts.rejectUnauthorized !== undefined) {
        throw new assert.AssertionError(
            'cannot set both opts.insecure and opts.rejectUnauthorized');
    } else if (opts.insecure !== undefined) {
        rejectUnauthorized = !opts.insecure;
    } else if (opts.rejectUnauthorized !== undefined) {
        rejectUnauthorized = opts.rejectUnauthorized;
    }

    var client = new DockerJsonClient({
        url: registryUrl,
        log: opts.log,
        userAgent: opts.userAgent || common.DEFAULT_USERAGENT,
        rejectUnauthorized: rejectUnauthorized,
        agent: opts.agent,
        proxy: opts.proxy
    });

    var headers = {};
    if (opts.authInfo) {
        headers.authorization = _authHeaderFromAuthInfo(opts.authInfo);
    } else if (opts.username) {
        headers.authorization = _basicAuthHeader(opts.username,
            opts.password);
    }

    client.get({
        path: '/v2/',
        headers: headers,
        // Ping should be fast. We don't want 15s of retrying.
        retry: false
    }, function _afterPing(err, req, res, body) {
        client.close();
        cb(err, body, res, req);
    });
}


/**
 * Login V2
 *
 * Typically one does not need to call this function directly because most
 * methods of a `RegistryClientV2` will automatically login as necessary.
 * Once exception is the `ping` method, which intentionally does not login.
 * That is because the point of the ping is to determine quickly if the
 * registry supports v2, which doesn't require the extra work of logging in.
 *
 * This attempts to reproduce the logic of "docker.git:registry/auth.go#loginV2"
 *
 * @param opts {Object}
 *      - opts.index {String|Object} Required. One of an index *name* (e.g.
 *        "docker.io", "quay.io") that `parseIndex` will handle, an index
 *        *url* (e.g. the default from `docker login` is
 *        'https://index.docker.io/v1/'), or an index *object* as returned by
 *        `parseIndex`. For backward compatibility, `opts.indexName` may be
 *        used instead of `opts.index`.
 *      - opts.username {String} Optional. Username and password are optional
 *        to allow `RegistryClientV2` to use `login` in the common case when
 *        there may or may not be auth required.
 *      - opts.password {String} Optional.
 *      - opts.scope {String} Optional. A scope string passed in for
 *        bearer/token auth. If this is just a login request where the token
 *        won't be used, then the empty string (the default) is sufficient.
 *        // JSSTYLED
 *        See <https://github.com/docker/distribution/blob/master/docs/spec/auth/token.md#requesting-a-token>
 *      - opts.pingRes {Object} Optional. The response object from an earlier
 *        `ping()` call. This can be used to save re-pinging.
 *      - opts.pingErr {Object} Required if `pingRes` given. The error
 *        object for `pingRes`.
 *      ...
 * @param cb {Function} `function (err, result)`
 *      On success, `result` is an object with:
 *          status      a string description of the login result status
 *          authInfo    an object with authentication info, examples:
 *                          {type: 'basic', username: '...', password: '...'}
 *                          {type: 'bearer', token: '...'}
 */
function login(opts, cb) {
    assert.object(opts, 'opts');
    assert.ok(opts.index || opts.indexName,
        'opts.index or opts.indexName is required');
    assert.optionalString(opts.username, 'opts.username');
    assert.optionalString(opts.password, 'opts.password');
    assert.optionalString(opts.scope, 'opts.scope');
    assert.optionalString(opts.userAgent, 'opts.userAgent');
    assert.optionalBool(opts.insecure, 'opts.insecure');
    assert.optionalObject(opts.pingRes, 'opts.pingRes');
    if (opts.pingRes && opts.pingRes.statusCode !== 200) {
        assert.object(opts.pingErr, 'opts.pingErr');
    } else {
        assert.optionalObject(opts.pingErr, 'opts.pingErr');
    }
    assert.optionalObject(opts.log, 'opts.log');
    assert.optionalString(opts.userAgent, 'opts.userAgent');
    assert.optionalObject(opts.agent, 'opts.agent');
    // assert.optional object or bool(opts.proxy, 'opts.proxy');
    assert.func(cb, 'cb');

    var index = opts.index || opts.indexName;
    if (typeof(index) === 'string') {
        try {
            var index = common.parseIndex(index);
        } catch (indexNameErr) {
            cb(indexNameErr);
            return;
        }
    } else {
        assert.object(index, 'opts.index');
    }

    var log = _createLogger(opts.log);
    log.trace({index: index, username: opts.username,
        password: (opts.password ? '(censored)' : '(none)'),
        scope: opts.scope, insecure: opts.insecure}, 'login');

    var scope = opts.scope || '';
    var authInfo;
    var context = {
        pingErr: opts.pingErr
    };

    vasync.pipeline({arg: context, funcs: [
        function ensureChalHeader(ctx, next) {
            if (opts.pingRes) {
                ctx.chalHeader = opts.pingRes.headers['www-authenticate'];
                if (ctx.chalHeader) {
                    return next();
                }
            }
            ping(opts, function (err, _, res, req) {
                if (!err) {
                    assert.equal(res.statusCode, 200,
                        'ping success without 200');
                    // This means Basic auth worked.
                    authInfo = {
                        type: 'basic',
                        username: opts.username,
                        password: opts.password
                    };
                    next(true);  // early pipeline abort
                } else if (res && res.statusCode === 401) {
                    var chalHeader = res.headers['www-authenticate'];

                    // DOCKER-627 hack for quay.io
                    if (!chalHeader && req._headers.host === 'quay.io') {
                        /* JSSTYLED */
                        chalHeader = 'Bearer realm="https://quay.io/v2/auth",service="quay.io"';
                    }

                    if (!chalHeader) {
                        next(new errors.UnauthorizedError(
                            'missing WWW-Authenticate header in 401 ' +
                            'response to "GET /v2/" (see ' +
                            /* JSSTYLED */
                            'https://docs.docker.com/registry/spec/api/#api-version-check)'));
                        return;
                    }

                    ctx.pingErr = err;
                    ctx.chalHeader = chalHeader;
                    next();
                } else {
                    next(err);
                }
            });
        },

        function parseAuthChallenge(ctx, next) {
            try {
                ctx.authChallenge = _parseWWWAuthenticate(ctx.chalHeader);
            } catch (chalErr) {
                return next(new errors.UnauthorizedError(chalErr));
            }
            next();
        },

        function basicAuthFail(ctx, next) {
            if (ctx.authChallenge.scheme.toLowerCase() !== 'basic') {
                return next();
            }

            /*
             * If the scheme is Basic, then we should already have failed
             * because username/password would have been in the original Ping.
             */
            log.debug('basicAuth fail');
            assert.ok(ctx.pingErr, 'no pingErr?');
            next(ctx.pingErr);
        },

        function bearerAuth(ctx, next) {
            if (ctx.authChallenge.scheme.toLowerCase() !== 'bearer') {
                return next();
            }
            log.debug({challenge: ctx.authChallenge},
                'login: get Bearer auth token');

            _getToken({
                indexName: index.name,
                realm: ctx.authChallenge.parms.realm,
                service: ctx.authChallenge.parms.service,
                scopes: scope ? [scope] : [],
                username: opts.username,
                password: opts.password,
                // HTTP client opts:
                log: log,
                agent: opts.agent,
                proxy: opts.proxy,
                userAgent: opts.userAgent,
                insecure: opts.insecure
            }, function (err, token) {
                if (err) {
                    return next(err);
                }
                log.debug({token: token}, 'login: Bearer auth token');
                authInfo = {
                    type: 'bearer',
                    token: token
                };
                next(true); // early pipeline abort
            });
        },

        function unknownAuthScheme(ctx, next) {
            next(new errors.UnauthorizedError('unsupported auth scheme: "%s"',
                ctx.authChallenge.scheme));
        }

    ]}, function (err) {
        if (err === true) { // early abort
            err = null;
        }
        log.trace({err: err, success: !err}, 'login: done');
        if (err) {
            cb(err);
        } else {
            cb(null, {
                status: 'Login Succeeded',
                authInfo: authInfo
            });
        }
    });
}



// --- RegistryClientV2

/**
 * Create a new Docker Registry V2 client for a particular repository.
 *
 * @param opts.insecure {Boolean} Optional. Default false. Set to true
 *      to *not* fail on an invalid or self-signed server certificate.
 * ... TODO: lots more to document
 *
 */
function RegistryClientV2(opts) {
    var self = this;
    assert.object(opts, 'opts');
    // One of `opts.name` or `opts.repo`.
    assert.ok((opts.name || opts.repo) && !(opts.name && opts.repo),
        'exactly one of opts.name or opts.repo must be given');
    if (opts.name) {
        assert.string(opts.name, 'opts.name');
    } else {
        assert.object(opts.repo, 'opts.repo');
    }
    assert.optionalObject(opts.log, 'opts.log');
    assert.optionalString(opts.username, 'opts.username');
    assert.optionalString(opts.password, 'opts.password');
    assert.optionalString(opts.token, 'opts.token');  // for Bearer auth
    assert.optionalBool(opts.insecure, 'opts.insecure');
    assert.optionalString(opts.scheme, 'opts.scheme');
    // TODO: options to control the trust db for CA verification
    // TODO add passing through other restify options: userAgent, ...
    // Restify/Node HTTP client options.
    assert.optionalBool(opts.agent, 'opts.agent');
    assert.optionalString(opts.userAgent, 'opts.userAgent');

    this.log = _createLogger(opts.log);

    this.insecure = Boolean(opts.insecure);
    if (opts.name) {
        this.repo = common.parseRepo(opts.name);
    } else {
        this.repo = common.deepObjCopy(opts.repo);
    }
    if (opts.scheme) {
        this.repo.index.scheme = opts.scheme;
    } else if (!this.repo.index.scheme
        && common.isLocalhost(this.repo.index.name))
    {
        // Per docker.git:registry/config.go#NewServiceConfig we special
        // case localhost to allow HTTP. Note that this lib doesn't do
        // the "try HTTPS, then fallback to HTTP if allowed" thing that
        // Docker-docker does, we'll just prefer HTTP for localhost.
        this.repo.index.scheme = 'http';
    }

    this.username = opts.username;
    this.password = opts.password;
    this._loggedIn = false;
    this._authInfo = null;
    this._headers = {
        authorization: _authHeaderFromAuthInfo({
            token: opts.token,
            username: opts.username,
            password: opts.password
        })
    };

    // XXX relevant for v2?
    //this._cookieJar = new tough.CookieJar();

    if (this.repo.index.official) {  // v1
        this._url = DEFAULT_V2_REGISTRY;
    } else {
        this._url = common.urlFromIndex(this.repo.index);
    }
    this.log.trace({url: this._url}, 'RegistryClientV2 url');

    this._commonHttpClientOpts = {
        log: this.log,
        agent: opts.agent,
        proxy: opts.proxy,
        rejectUnauthorized: !this.insecure,
        userAgent: opts.userAgent || common.DEFAULT_USERAGENT
    };
    this._clientsToClose = [];

    Object.defineProperty(this, '_api', {
        get: function () {
            if (self.__api === undefined) {
                self.__api = new DockerJsonClient(common.objMerge({
                    url: self._url
                }, self._commonHttpClientOpts));
                self._clientsToClose.push(self.__api);
            }
            return this.__api;
        }
    });
}


RegistryClientV2.prototype.version = 2;


RegistryClientV2.prototype.close = function close() {
    for (var i = 0; i < this._clientsToClose.length; i++) {
        var client = this._clientsToClose[i];
        this.log.trace({host: client.url && client.url.host},
            'close http client');
        client.close();
    }
    this._clientsToClose = [];
};


/**
 * Ping the base URL.
 * https://docs.docker.com/registry/spec/api/#base
 */
RegistryClientV2.prototype.ping = function regPing(cb) {
    ping(common.objMerge({
        index: this.repo.index,
        username: this.username,
        password: this.password,
        authInfo: this._authInfo
    }, this._commonHttpClientOpts), cb);
};


/**
 * Get a registry session (i.e. login to the registry).
 *
 * Typically one does not need to call this method directly because most
 * methods of a client will automatically login as necessary.
 * Once exception is the `ping` method, which intentionally does not login.
 * That is because the point of the ping is to determine quickly if the
 * registry supports v2, which doesn't require the extra work of logging in.
 * See <https://github.com/joyent/node-docker-registry-client/pull/6> for
 * an example of the latter.
 *
 * This attempts to reproduce the logic of "docker.git:registry/auth.go#loginV2"
 *
 * @param opts {Object} Optional.
 *      - opts.pingRes {Object} Optional. The response object from an earlier
 *        `ping()` call. This can be used to save re-pinging.
 *      - opts.pingErr {Object} Required if `pingRes` given. The error
 *        object for `pingRes`.
 * @param cb {Function} `function (err)`
 *
 * Side-effects:
 * - On success, all of `this._loggedIn`, `this._authInfo`, and
 *   `this._headers.authorization` are set.
 */
RegistryClientV2.prototype.login = function regLogin(opts, cb) {
    if (cb === undefined) {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    if (this._loggedIn) {
        return cb();
    }

    // TODO: expose requested token actions to ctor
    var self = this;
    var resource = 'repository';
    var actions = ['pull'];
    var scope = fmt('%s:%s:%s', resource, self.repo.remoteName,
        actions.join(','));

    login(common.objMerge({
        index: self.repo.index,
        username: self.username,
        password: self.password,
        pingRes: opts.pingRes,
        pingErr: opts.pingErr,
        scope: scope
    }, self._commonHttpClientOpts), function (err, result) {
        if (!err) {
            assert.ok(result);
            self._loggedIn = true;
            self._authInfo = result.authInfo;
            self._headers.authorization =
                _authHeaderFromAuthInfo(self._authInfo);
        }
        self.log.trace({err: err, loggedIn: self._loggedIn}, 'login: done');
        cb(err);
    });
};


//RegistryClientV2.prototype._saveCookies = function _saveCookies(url, res) {
//    var header = res.headers['set-cookie'];
//    if (!header) {
//        return;
//    }
//
//    var cookie;
//    if (Array.isArray(header)) {
//        for (var i = 0; i < header.length; i++) {
//            cookie = tough.Cookie.parse(header[i]);
//            this._cookieJar.setCookieSync(cookie, url);
//        }
//    } else {
//        cookie = tough.Cookie.parse(header[i]);
//        this._cookieJar.setCookieSync(cookie, url);
//    }
//};
//
//
//RegistryClientV2.prototype._getCookies = function _getCookies(url) {
//    var cookies = this._cookieJar.getCookiesSync(url);
//    if (cookies.length) {
//        return cookies.join('; ');
//    }
//};



/**
 * Determine if this registry supports the v2 API.
 * https://docs.docker.com/registry/spec/api/#api-version-check
 *
 * Note that, at least, currently we are presuming things are fine with a 401.
 * I.e. defering auth to later calls.
 *
 * @param cb {Function} `function (err, supportsV2)`
 *      where `supportsV2` is a boolean indicating if V2 API is supported.
 */
RegistryClientV2.prototype.supportsV2 = function supportsV2(cb) {
    this.ping(function (err, body, res) {
        if (res && (res.statusCode === 200 || res.statusCode === 401)) {
            var header = res.headers['docker-distribution-api-version'];
            if (header) {
                var versions = header.split(/\s+/g);
                if (versions.indexOf('registry/2.0') !== -1) {
                    return cb(null, true);
                }
            }
        }
        cb(null, false);
    });
};


RegistryClientV2.prototype.listTags = function listTags(cb) {
    var self = this;
    assert.func(cb, 'cb');

    var res, repoTags;
    vasync.pipeline({arg: this, funcs: [
        function doLogin(_, next) {
            self.login(next);
        },
        function call(_, next) {
            self._api.get({
                path: fmt('/v2/%s/tags/list',
                    encodeURI(self.repo.remoteName)),
                headers: self._headers
            }, function _afterCall(err, req, res_, repoTags_) {
                if (err) {
                    return next(err);
                }
                repoTags = repoTags_;
                res = res_;
                next();
            });
        }
    ]}, function (err) {
        cb(err, repoTags, res);
    });
};

/*
 * Get an image manifest. `ref` is either a tag or a digest.
 * <https://docs.docker.com/registry/spec/api/#pulling-an-image-manifest>
 *
 *   client.getManifest({ref: <tag or digest>}, function (err, manifest, res) {
 *      // Use `manifest` and digest is `res.headers['docker-content-digest']`.
 *   });
 */
RegistryClientV2.prototype.getManifest = function getManifest(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.ref, 'opts.ref');
    assert.func(cb, 'cb');

    var res, manifest;
    vasync.pipeline({arg: this, funcs: [
        function doLogin(_, next) {
            self.login(next);
        },
        function call(_, next) {
            self._api.get({
                path: fmt('/v2/%s/manifests/%s',
                    encodeURI(self.repo.remoteName),
                    encodeURIComponent(opts.ref)),
                headers: self._headers
            }, function _afterCall(err, req, res_, manifest_, body) {
                if (err) {
                    return next(err);
                }

                try {
                    var jws = _jwsFromManifest(manifest_, body);
                    _verifyManifestDockerContentDigest(res_, jws);
                    _verifyJws(jws);
                } catch (verifyErr) {
                    return next(verifyErr);
                }

                if (manifest_.schemaVersion !== 1) {
                    throw new restify.InvalidContentError(fmt(
                        'unsupported schema version %s in %s:%s manifest',
                        manifest_.schemaVersion, self.repo.localName,
                        opts.ref));
                }
                if (manifest_.fsLayers.length !== manifest_.history.length) {
                    throw new restify.InvalidContentError(fmt(
                        'length of history not equal to number of layers in ' +
                        '%s:%s manifest', self.repo.localName, opts.ref));
                }
                if (manifest_.fsLayers.length === 0) {
                    throw new restify.InvalidContentError(fmt(
                        'no layers in %s:%s manifest', self.repo.localName,
                        opts.ref));
                }

                // TODO: `verifyTrustedKeys` from
                // docker/graph/pull_v2.go#validateManifest()

                manifest = manifest_;
                res = res_;
                next();
            });
        }
    ]}, function (err) {
        cb(err, manifest, res);
    });
};



RegistryClientV2.prototype._headOrGetBlob = function _headOrGetBlob(opts, cb) {
    var self = this;
    assert.object(opts, 'opts');
    assert.string(opts.method, 'opts.method');
    assert.string(opts.digest, 'opts.digest');
    assert.func(cb, 'cb');

    var ress = [];

    vasync.pipeline({arg: this, funcs: [
        function doLogin(_, next) {
            self.login(next);
        },
        function call(_, next) {
            // We want a non-redirect (i.e. non-3xx) response to return. Use a
            // barrier to gate that.
            var barrier = vasync.barrier();
            barrier.on('drain', function _onGetNonRedirResult() {
                self.log.trace(
                    {res: ress[ress.length - 1], digest: opts.digest},
                    'got a non-redir response');
                next(null, ress);
            });

            var MAX_NUM_REDIRS = 3;
            var numRedirs = 0;
            function makeReq(reqOpts) {
                if (numRedirs >= MAX_NUM_REDIRS) {
                    next(new errors.DownloadError(fmt(
                        'maximum number of redirects (%s) hit ' +
                        'when attempting to get blob for digest %s',
                        MAX_NUM_REDIRS, opts.digest)));
                    return;
                }
                numRedirs += 1;

                var client = restify.createHttpClient(common.objMerge({
                    url: reqOpts.url
                }, self._commonHttpClientOpts));
                self._clientsToClose.push(client);

                client[opts.method](reqOpts, function _onConn(connErr, req) {
                    if (connErr) {
                        next(connErr);
                        return;
                    }
                    req.on('result', function (err, res) {
                        ress.push(res);
                        if (err) {
                            next(err);
                            return;
                        }
                        if (res.statusCode === 302 || res.statusCode === 307) {
                            var loc = mod_url.parse(res.headers.location);
                            makeReq({
                                url: loc.protocol + '//' + loc.host,
                                path: loc.path
                            });
                        } else {
                            // party like it's node 0.10
                            common.pauseStream(res);
                            barrier.done('nonRedirRes');
                        }
                    });
                });
            }

            barrier.start('nonRedirRes');
            makeReq({
                url: self._url,
                path: fmt('/v2/%s/blobs/%s',
                    encodeURI(self.repo.remoteName),
                    encodeURIComponent(opts.digest)),
                headers: self._headers
            }, next);
        }
    ]}, function (err) {
        cb(err, ress);
    });
};


/*
 * Get an image file blob -- just the headers. See `getBlob`.
 *
 * <https://docs.docker.com/registry/spec/api/#get-blob>
 * <https://docs.docker.com/registry/spec/api/#pulling-an-image-manifest>
 *
 * This endpoint can return 3xx redirects. An example first hit to Docker Hub
 * yields this response
 *
 *      HTTP/1.1 307 Temporary Redirect
 *      docker-content-digest: sha256:b15fbeba7181d178e366a5d8e0...
 *      docker-distribution-api-version: registry/2.0
 *      location: https://dseasb33srnrn.cloudfront.net/registry-v2/...
 *      date: Mon, 01 Jun 2015 23:43:55 GMT
 *      content-type: text/plain; charset=utf-8
 *      connection: close
 *      strict-transport-security: max-age=3153600
 *
 * And after resolving redirects, this:
 *
 *      HTTP/1.1 200 OK
 *      Content-Type: application/octet-stream
 *      Content-Length: 2471839
 *      Connection: keep-alive
 *      Date: Mon, 01 Jun 2015 20:23:43 GMT
 *      Last-Modified: Thu, 28 May 2015 23:02:16 GMT
 *      ETag: "f01c599df7404875a0c1740266e74510"
 *      Accept-Ranges: bytes
 *      Server: AmazonS3
 *      Age: 11645
 *      X-Cache: Hit from cloudfront
 *      Via: 1.1 e3799a12d0e2fdaad3586ff902aa529f.cloudfront.net (CloudFront)
 *      X-Amz-Cf-Id: 8EUekYdb8qGK48Xm0kmiYi1GaLFHbcv5L8fZPOUWWuB5zQfr72Qdfg==
 *
 * A client will typically want to follow redirects, so by default we
 * follow redirects and return a responses. If needed a `opts.noFollow=true`
 * could be implemented.
 *
 *      cb(err, ress)   // `ress` is the plural of `res` for "response"
 *
 * Interesting headers:
 * - `ress[0].headers['docker-content-digest']` is the digest of the
 *   content to be downloaded
 * - `ress[-1].headers['content-length']` is the number of bytes to download
 * - `ress[-1].headers[*]` as appropriate for HTTP caching, range gets, etc.
 */
RegistryClientV2.prototype.headBlob = function headBlob(opts, cb) {
    this._headOrGetBlob({
        method: 'head',
        digest: opts.digest
    }, cb);
};


/**
 * Get a *paused* readable stream to the given blob.
 * <https://docs.docker.com/registry/spec/api/#get-blob>
 *
 * Possible usage:
 *
 *      client.createBlobReadStream({digest: DIGEST}, function (err, stream) {
 *          var fout = fs.createWriteStream('/var/tmp/blob-%s.file', DIGEST);
 *          fout.on('finish', function () {
 *              console.log('Done downloading blob', DIGEST);
 *          });
 *          stream.pipe(fout);
 *          stream.resume();
 *      });
 *
 * See "examples/v2/downloadBlob.js" for a more complete example.
 * This stream will verify 'Docker-Content-Digest' and 'Content-Length'
 * response headers, calling back with `BadDigestError` if they don't verify.
 *
 * Note: While the spec says the registry response will include the
 * Docker-Content-Digest and Content-Length headers, there is a suggestion that
 * this was added to the spec in rev "a", see
 * <https://docs.docker.com/registry/spec/api/#changes>. Also, if I read it
 * correctly, it looks like Docker's own registry client code doesn't
 * require those headers:
 *     // JSSTYLED
 *     https://github.com/docker/distribution/blob/master/registry/client/repository.go#L220
 * So this implementation won't require them either.
 *
 * @param opts {Object}
 *      - digest {String}
 * @param cb {Function} `function (err, stream, ress)`
 *      The `stream` is also an HTTP response object, i.e. headers are on
 *      `stream.headers`. `ress` (plural of 'res') is an array of responses
 *      after following redirects. The latest response is the same object
 *      as `stream`. The full set of responses are returned mainly because
 *      headers on both the first, e.g. 'Docker-Content-Digest', and last,
 *      e.g. 'Content-Length', might be interesting.
 */
RegistryClientV2.prototype.createBlobReadStream =
        function createBlobReadStream(opts, cb) {
    this._headOrGetBlob({
        method: 'get',
        digest: opts.digest
    }, function (err, ress) {
        if (err) {
            return cb(err, null, ress);
        }

        var stream = ress[ress.length - 1];
        var numBytes = 0;

        var dcdInfo;
        var dcdHeader = ress[0].headers['docker-content-digest'];
        if (dcdHeader) {
            try {
                dcdInfo = _parseDockerContentDigest(dcdHeader);
            } catch (parseErr) {
                return cb(new restify.BadDigestError(fmt(
                    'could not parse Docker-Content-Digest header, "%s": %s',
                    dcdHeader)));
            }
            if (dcdInfo.raw !== opts.digest) {
                return cb(new restify.BadDigestError(fmt(
                    'Docker-Content-Digest header, %s, does not match ' +
                    'given digest, %s', dcdInfo.raw, opts.digest)));
            }
        } else {
            stream.log.debug({headers: ress[0].headers},
                'no Docker-Content-Digest header on GetBlob response');
        }

        stream.on('data', function (chunk) {
            numBytes += chunk.length;
            if (dcdInfo) {
                dcdInfo.hash.update(chunk);
            }
        });
        stream.on('end', function () {
            var cLen = Number(stream.headers['content-length']);
            if (!isNaN(cLen) && numBytes !== cLen) {
                stream.emit('error', new errors.DownloadError(fmt(
                    'unexpected downloaded size: expected %d bytes, ' +
                    'downloaded %d bytes', cLen, numBytes)));
            } else if (dcdInfo) {
                var digest = dcdInfo.hash.digest('hex');
                if (dcdInfo.expectedDigest !== digest) {
                    stream.log.trace({expectedDigest: dcdInfo.expectedDigest,
                        header: dcdInfo.raw, digest: digest},
                        'Docker-Content-Digest failure');
                    stream.emit('error', new restify.BadDigestError(
                        'Docker-Content-Digest'));
                }
            }
        });

        cb(null, stream, ress);
    });
};



// --- Exports

function createClient(opts) {
    return new RegistryClientV2(opts);
}

module.exports = {
    createClient: createClient,
    ping: ping,
    login: login
};
