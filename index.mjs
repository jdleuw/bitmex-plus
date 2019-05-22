import BitMEXWs from 'bitmex-realtime-api';
import crypto from 'crypto';
import qs from 'qs';
import fetch from 'node-fetch';

const debug = require('debug')('bitmex-plus');

export class BitMexPlus extends BitMEXWs {
  constructor(options) {
    super(options);
    this.options = options;
    this.rateLimit = {
      limit: 30,
      remaining: 0,
      reset: 0
    }

    this.init();
  }

  /**
   * Make an initial request for populating the rate limit
   */
  init() {

    // Ensure we have at least 1 request available
    this.rateLimit.remaining = 1;

    this.makeRequest('GET', '', {}, -1).then(response => {
      this.offsetTime = new Date().getTime() - response.timestamp;

      // Update remaining rate limit every second with rate per second
      setInterval(() => {
        this.rateLimit.remaining = Math.min(this.rateLimit.limit, this.rateLimit.remaining + this.rateLimit.limit / 60);
        debug('Calculated remaining limit: ', this.rateLimit.remaining);
      }, 1000);
    })
  }

  getServerTime() {
    return new Date(new Date().getTime() - this.offsetTime);
  }

  setRateLimit(key, value) {
    if (isNaN(value) || value < 1) {
      value = key === 'limit' ? 30 : 10;
    }
    this.rateLimit[key] = parseInt(value, 10);
  }

  throttle(limit) {

    // Decrease our limit in case other parallel requests are incoming
    this.rateLimit.remaining--;
    return new Promise((resolve, reject) => {
      let retries = 400;
      const check = () => {
        if (this.rateLimit.remaining > limit) {
          resolve();
        } else {
          retries--;
          if (!retries) {
            reject('No more retries');
          } else {
            setTimeout(() => {
              check();
            }, 250);
          }
        }
      }
      check();
    });
  }

  /**
   * Subscribe to a stream and call a callback for every new item
   * @param {String} [symbol='XBTUSD']
   * @param {String} tableName - e.g. 'trade', 'quote', 'orderBookL2', 'instrument' etc.
   * @param {Function} callback(data)
   */
  monitorStream(symbol = 'XBTUSD', tableName, callback) {
    let lastItem;
    this.addStream(symbol, tableName, data => {
      if (!data.length) return;
      if (tableName === 'orderBookL2')
        callback();  // callback must deal with the entire data array returned by getData(), no need to pass it anything
      else
        // On the first piece(s) of data, lastItem is undefined so lastIndexOf + 1 === 0.
        // Same if maxTableLen was too small (the lastItem would be splice'd out).
        for (let i = data.lastIndexOf(lastItem) + 1; i < data.length; i++)
          callback(data[i]);
      lastItem = data[data.length - 1];
    });
  }

  /**
   * Send a request to the BitMEX REST API. See https://www.bitmex.com/api/explorer/.
   * @param {string} verb - GET/PUT/POST/DELETE
   * @param {string} endpoint - e.g. `/user/margin`
   * @param {object} data - JSON
   * @param {number} limit - Minimal remaining limit required to proceed
   * @returns {Promise<object>} - JSON response
   */
  makeRequest(verb, endpoint, data = {}, limit = 10) {
    const apiRoot = '/api/v1/';

    let query = '', postBody = '';
    if (verb === 'GET')
      query = '?' + qs.stringify(data);
    else
      // Pre-compute the postBody so we can be sure that we're using *exactly* the same body in the request
      // and in the signature. If you don't do this, you might get differently-sorted keys and blow the signature.
      postBody = JSON.stringify(data);

    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json',
      // This example uses the 'expires' scheme. You can also use the 'nonce' scheme.
      // See https://www.bitmex.com/app/apiKeysUsage for more details.
    };

    if (this.options.apiKeyID && this.options.apiKeySecret) {
      const expires = new Date().getTime() + (60 * 1000);  // 1 min in the future
      const signature = crypto.createHmac('sha256', this.options.apiKeySecret)
        .update(verb + apiRoot + endpoint + query + expires + postBody).digest('hex');
      headers['api-expires'] = expires;
      headers['api-key'] = this.options.apiKeyID;
      headers['api-signature'] = signature;
    }

    const requestOptions = {
      method: verb,
      headers,
    };
    if (verb !== 'GET') requestOptions.body = postBody;  // GET/HEAD requests can't have body

    const apiBase = this.options.testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
    const url = apiBase + apiRoot + endpoint + query;

    return this.throttle(limit).then(() => fetch(url, requestOptions)).then(response => {
      for (let key in this.rateLimit) {
        this.setRateLimit(key, +response.headers.get('x-ratelimit-' + key));
      };
      debug('Fetched remaining limit: ', this.rateLimit.remaining);
      return response.json();
    }).then(
      response => {
        if ('error' in response)
          throw new Error(`${response.error.message} during ${verb} ${endpoint} with ${JSON.stringify(data)}`);
        return response;
      }, error => {
        throw new Error(error);
      },
    );
  }
}
