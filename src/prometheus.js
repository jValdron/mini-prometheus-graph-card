import { log } from './utils';

const INVALID_SAMPLE = /^(NaN|\+Inf|-Inf|Inf|stale)$/i;
const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)$/;
const UNIT_SECONDS = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31536000,
};

export class PrometheusError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrometheusError';
  }
}

export default class Prometheus {
  constructor(config = {}) {
    this._url = String(config.url || '').replace(/\/$/, '');
    this._headers = this._buildHeaders(config);
  }

  static parseDuration(value, fallback) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? value : fallback;
    }
    const trimmed = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const seconds = Number(trimmed);
      return seconds > 0 ? seconds : fallback;
    }
    const match = trimmed.match(DURATION_RE);
    if (!match) return fallback;
    const seconds = Number(match[1]) * UNIT_SECONDS[match[2]];
    return seconds > 0 ? seconds : fallback;
  }

  async queryInstant(query, time) {
    const params = { query };
    if (time != null) params.time = String(this._toUnix(time));
    const data = await this._fetch('/api/v1/query', params);
    return this._historyFromResult(data, query);
  }

  async queryRange(query, start, end, step) {
    const data = await this._fetch('/api/v1/query_range', {
      query,
      start: String(this._toUnix(start)),
      end: String(this._toUnix(end)),
      step: String(step),
    });
    return this._historyFromResult(data, query);
  }

  _buildHeaders(config) {
    const headers = {};
    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    } else if (config.username != null && config.username !== '') {
      headers.Authorization = `Basic ${btoa(`${config.username}:${config.password || ''}`)}`;
    }
    return { ...headers, ...(config.headers || {}) };
  }

  _toUnix(date) {
    return date instanceof Date ? date.getTime() / 1000 : Number(date);
  }

  _buildUrl(path, params) {
    const url = new URL(`${this._url}${path}`);
    Object.keys(params).forEach((key) => {
      if (params[key] != null) url.searchParams.set(key, params[key]);
    });
    return url.toString();
  }

  async _fetch(path, params) {
    let response;
    try {
      response = await fetch(this._buildUrl(path, params), { headers: this._headers });
    } catch (err) {
      throw new PrometheusError(
        `Failed to reach Prometheus: ${err.message}. `
        + 'If this is a cross-origin URL, enable CORS on Prometheus or use a same-origin reverse proxy.',
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new PrometheusError(`Prometheus HTTP ${response.status}: response was not JSON`);
    }

    if (!response.ok) {
      throw new PrometheusError(payload.error || `Prometheus HTTP ${response.status}`);
    }
    if (payload.status !== 'success') {
      throw new PrometheusError(payload.error || 'Prometheus query failed');
    }
    return payload.data;
  }

  _samplesToHistory(samples) {
    if (!Array.isArray(samples)) return [];
    return samples.reduce((acc, sample) => {
      if (!sample || sample.length < 2) return acc;
      const value = sample[1];
      if (value == null || INVALID_SAMPLE.test(String(value))) return acc;
      const numeric = parseFloat(value);
      if (Number.isNaN(numeric)) return acc;
      acc.push({
        last_changed: new Date(sample[0] * 1000).toISOString(),
        state: numeric,
      });
      return acc;
    }, []);
  }

  _firstSeries(result, query) {
    if (!Array.isArray(result) || result.length === 0) return null;
    if (result.length > 1) {
      log(`PromQL returned ${result.length} series for "${query}"; using the first. Narrow the selector or aggregate.`);
    }
    return result[0];
  }

  _historyFromResult(data, query) {
    if (!data) return [];
    const { resultType, result } = data;
    if (resultType === 'scalar') {
      return this._samplesToHistory([result]);
    }
    if (resultType === 'vector') {
      const series = this._firstSeries(result, query);
      if (!series || !series.value) return [];
      return this._samplesToHistory([series.value]);
    }
    if (resultType === 'matrix') {
      const series = this._firstSeries(result, query);
      if (!series) return [];
      return this._samplesToHistory(series.values || []);
    }
    log(`Unsupported Prometheus resultType "${resultType}"`);
    return [];
  }
}
