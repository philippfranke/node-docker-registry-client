/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var crypto = require('crypto');
var strsplit = require('strsplit');
var test = require('tape');

var drc = require('..');


// --- globals

var log = require('./lib/log');

var REPO = 'busybox';
var TAG = 'latest';



// --- Tests

test('v2 docker.io', function (tt) {
    var client;
    var repo = drc.parseRepo(REPO);

    tt.test('  createClient', function (t) {
        client = drc.createClientV2({
            name: REPO,
            log: log
        });
        t.ok(client);
        t.equal(client.version, 2);
        t.end();
    });

    tt.test('  ping', function (t) {
        client.ping(function (err, body, res) {
            t.ok(err);
            t.ok(res, 'have a response');
            if (res) {
                t.equal(res.statusCode, 401);
                t.ok(res.headers['www-authenticate']);
            }
            t.end();
        });
    });

    /*
     * Example expected output:
     *  {
     *      "name": "library/alpine",
     *      "tags": [ "2.6", "2.7", "3.1", "3.2", "edge", "latest" ]
     *  }
     */
    tt.test('  listTags', function (t) {
        client.listTags(function (err, tags) {
            t.ifErr(err);
            t.ok(tags);
            t.equal(tags.name, repo.remoteName);
            t.ok(tags.tags.indexOf(TAG) !== -1, 'no "'+TAG+'" tag');
            t.end();
        });
    });

    /*
     *  {
     *      "name": <name>,
     *      "tag": <tag>,
     *      "fsLayers": [
     *         {
     *            "blobSum": <tarsum>
     *         },
     *         ...
     *      ],
     *      "history": <v1 images>,
     *      "signature": <JWS>
     *  }
     */
    var manifest;
    var manifestDigest;
    tt.test('  getManifest', function (t) {
        client.getManifest({ref: TAG}, function (err, manifest_, res) {
            t.ifErr(err);
            manifest = manifest_;
            manifestDigest = res.headers['docker-content-digest'];
            t.ok(manifest);
            t.equal(manifest.schemaVersion, 1);
            t.equal(manifest.name, repo.remoteName);
            t.equal(manifest.tag, TAG);
            t.ok(manifest.architecture);
            t.ok(manifest.fsLayers);
            t.ok(manifest.history[0].v1Compatibility);
            t.ok(manifest.signatures[0].signature);
            t.end();
        });
    });

    tt.test('  getManifest (by digest)', function (t) {
        client.getManifest({ref: manifestDigest}, function (err, manifest_) {
            t.ifErr(err);
            t.ok(manifest);
            ['schemaVersion',
             'name',
             'tag',
             'architecture'].forEach(function (k) {
                t.equal(manifest_[k], manifest[k], k);
            });
            t.end();
        });
    });

    tt.test('  getManifest (unknown tag)', function (t) {
        client.getManifest({ref: 'unknowntag'}, function (err, manifest_) {
            t.ok(err);
            t.notOk(manifest_);
            t.equal(err.statusCode, 404);
            t.end();
        });
    });

    tt.test('  headBlob', function (t) {
        var digest = manifest.fsLayers[0].blobSum;
        client.headBlob({digest: digest}, function (err, ress) {
            t.ifErr(err, 'no headBlob err');
            t.ok(ress, 'got a "ress"');
            t.ok(Array.isArray(ress), '"ress" is an array');
            var first = ress[0];
            t.ok(first.statusCode === 200 || first.statusCode === 307,
                'first response statusCode is 200 or 307');
            if (first.headers['docker-content-digest']) {
                t.equal(first.headers['docker-content-digest'], digest,
                    '"docker-content-digest" header from first response is '
                    + 'the queried digest');
            }
            t.equal(first.headers['docker-distribution-api-version'],
                'registry/2.0',
                '"docker-distribution-api-version" header is "registry/2.0"');
            var last = ress[ress.length - 1];
            t.equal(last.statusCode, 200, 'last response statusCode is 200');
            var contentType = last.headers['content-type'];
            t.ok(['application/octet-stream', 'application/x-gzip']
                .indexOf(contentType) !== -1,
                'content-type is as expected, got ' + contentType);
            t.ok(last.headers['content-length']);
            t.end();
        });
    });

    tt.test('  headBlob (unknown digest)', function (t) {
        client.headBlob({digest: 'cafebabe'}, function (err, ress) {
            t.ok(err);
            t.ok(ress);
            t.ok(Array.isArray(ress));
            t.equal(ress.length, 1);
            var res = ress[0];
            t.equal(res.statusCode, 404);
            t.equal(res.headers['docker-distribution-api-version'],
                'registry/2.0');
            t.end();
        });
    });

    tt.test('  createBlobReadStream', function (t) {
        var digest = manifest.fsLayers[0].blobSum;
        client.createBlobReadStream({digest: digest},
                function (err, stream, ress) {
            t.ifErr(err, 'createBlobReadStream err');

            t.ok(ress, 'got responses');
            t.ok(Array.isArray(ress), 'ress is an array');
            var first = ress[0];
            t.ok(first.statusCode === 200 || first.statusCode === 307,
                'createBlobReadStream first res statusCode is 200 or 307');
            if (first.headers['docker-content-digest']) {
                t.equal(first.headers['docker-content-digest'], digest,
                    '"docker-content-digest" header from first response is '
                    + 'the queried digest');
            }
            t.equal(first.headers['docker-distribution-api-version'],
                'registry/2.0',
                '"docker-distribution-api-version" header is "registry/2.0"');

            t.ok(stream, 'got a stream');
            t.equal(stream.statusCode, 200, 'stream statusCode is 200');
            t.equal(stream.headers['content-type'], 'application/octet-stream');
            t.ok(stream.headers['content-length'] !== undefined,
                'got a "content-length" header');

            var numBytes = 0;
            var hash = crypto.createHash(digest.split(':')[0]);
            stream.on('data', function (chunk) {
                hash.update(chunk);
                numBytes += chunk.length;
            });
            stream.on('end', function () {
                t.equal(hash.digest('hex'), digest.split(':')[1]);
                t.equal(numBytes, Number(stream.headers['content-length']));
                t.end();
            });
            stream.resume();
        });
    });

    tt.test('  createBlobReadStream (unknown digest)', function (t) {
        client.createBlobReadStream({digest: 'cafebabe'},
                function (err, stream, ress) {
            t.ok(err);
            t.ok(ress);
            t.ok(Array.isArray(ress));
            t.equal(ress.length, 1);
            var res = ress[0];
            t.equal(res.statusCode, 404);
            t.equal(res.headers['docker-distribution-api-version'],
                'registry/2.0');
            t.end();
        });
    });

    tt.test('  close', function (t) {
        client.close();
        t.end();
    });
});
