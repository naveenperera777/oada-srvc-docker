/* Copyright 2017 Open Ag Data Alliance
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const debug = require('debug');
const trace = debug('rev-graph-update:trace');
const info = debug('rev-graph-update:info');
const error = debug('rev-graph-update:error');

const Promise = require('bluebird');
const kf = require('kafka-node');
const oadaLib = require('../../libs/oada-lib-arangodb');
const config = require('./config');

//---------------------------------------------------------
// Kafka intializations:
const client = new kf.Client(
  config.get('zookeeper:host'),
  config.get('zookeeper:revGraphUpdate')
);
const offset = new kf.Offset(client);
const consumer = new kf.ConsumerGroup({
  host: config.get('zookeeper:host'),
  groupId: 'rev-graph-update',
  fromOffset: 'latest'
}, [config.get('kafka:topics:httpResponse')]);
let producer = new kf.Producer(client, {partitionerType: 0});

process.on('exit', () => {info('Exiting'); client.close()});
process.on('SIGINT', () => {info('Sigint'); client.close(); process.exit(2);});
process.on('uncaughtException', (a) => {error(a); client.close(); process.exit(99);});

consumer.on('message', (msg) => {
  return Promise.try(() => {
      return JSON.parse(msg.value);
    })
    .then((req) => {
      if (!req || req.msgtype !== 'write-response') {
        trace('Received message, but msgtype is not write-response to ignoring message');
        return []; // not a write-response message, ignore it
      }
      if (req.code != 'success') {
        trace('Received write response message, but code was not "success" so ignoring message');
        return [];
      }
      if(typeof req.resource_id === "undefined" ||
				 typeof req._rev === "undefined" ) {
        throw new Error(`Invalid http_response: there is either no resource_id or _rev.  respose = ${JSON.stringify(req)}`);
      }

			if (typeof req.user_id === "undefined") {
				trace('WARNING: received message does not have user_id');
			}

			if (typeof req.authorizationid === "undefined") {
				trace('WARNING: received message does not have authorizationid');
			}

      const res = {
        type: 'write_request',
				resource_id: null,
				path_leftover: null,
				connection_id: req.connection_id,
				contentType: null,
				body: null,
				url: "",
				user_id: req.user_id,
				authorizationid: req.authorizationid,
        resp_partition: msg.partition,
        source: 'rev-graph-update',
      };

			trace('find parents for resource_id = ', req.resource_id);

			// find resource's parent
			return oadaLib.resources.getParents(req.resource_id)
				.then(p => {
					if (p.length === 0) {
						info('WARNING: resource_id '+req.resource_id+' does not have a parent.');
						return [];
					}

					trace('the parents are: ', p);

					return Promise.map(p, item => {
						trace('parent resource_id = ', item.resource_id);
						res.resource_id = item.resource_id;
						res.path_leftover = item.path + '/_rev';
						res.contentType = item.contentType;
						res.body = req._rev;
							return Promise.fromCallback((done) => {
								trace('kafka intends to produce: ', res);
								// produce multiple kafka messages
								producer.send([{
									topic: config.get('kafka:topics:writeRequest'),
									partitions: 0,
									messages: JSON.stringify(res)
								}], done);
							});
					});
			});
  })
  .catch(err => {
    error('%O', err);
  })
  .finally(() =>
    offset.commit('rev-graph-update', [{
      topic: config.get('kafka:topics:httpResponse'),
      partition: msg.partition,
      offset: msg.offset
    }])
  );
});

