import sentryPlugin from "@cloudflare/pages-plugin-sentry";
import '@sentry/tracing';

export async function errorHandling(context) {
  const env = context.env;
  if (typeof env.disable_telemetry == "undefined" || env.disable_telemetry == null || env.disable_telemetry == "") {
    context.data.telemetry = true;
    let remoteSampleRate = 0.001;
    try {
      const sampleRate = await fetchSampleRate(context)
      //check if the sample rate is not null
      if (sampleRate) {
        remoteSampleRate = sampleRate;
      }
    } catch (e) { console.log(e) }
    const sampleRate = env.sampleRate || remoteSampleRate;
    return sentryPlugin({
      dsn: "https://219f636ac7bde5edab2c3e16885cb535@o4507041519108096.ingest.us.sentry.io/4507541492727808",
      tracesSampleRate: sampleRate,
    })(context);;
  }
  return context.next();
}

export function telemetryData(context) {
  const env = context.env;
  if (typeof env.disable_telemetry == "undefined" || env.disable_telemetry == null || env.disable_telemetry == "") {
    try {
      const parsedHeaders = {};
      context.request.headers.forEach((value, key) => {
        parsedHeaders[key] = value
        //check if the value is empty
        if (value.length > 0) {
          context.data.sentry.setTag(key, value);
        }
      });
      const CF = JSON.parse(JSON.stringify(context.request.cf));
      const parsedCF = {};
      for (const key in CF) {
        if (typeof CF[key] == "object") {
          parsedCF[key] = JSON.stringify(CF[key]);
        } else {
          parsedCF[key] = CF[key];
          if (CF[key].length > 0) {
            context.data.sentry.setTag(key, CF[key]);
          }
        }
      }
      const data = {
        headers: parsedHeaders,
        cf: parsedCF,
        url: context.request.url,
        method: context.request.method,
        redirect: context.request.redirect,
      }
      //get the url path
      const urlPath = new URL(context.request.url).pathname;
      const hostname = new URL(context.request.url).hostname;
      context.data.sentry.setTag("path", urlPath);
      context.data.sentry.setTag("url", data.url);
      context.data.sentry.setTag("method", context.request.method);
      context.data.sentry.setTag("redirect", context.request.redirect);
      context.data.sentry.setContext("request", data);
      const transaction = context.data.sentry.startTransaction({ name: `${context.request.method} ${hostname}` });
      //add the transaction to the context
      context.data.transaction = transaction;
      return context.next();
    } catch (e) {
      console.log(e);
    } finally {
      context.data.transaction.finish();
    }
  }
  return context.next();
}

export async function traceData(context, span, op, name) {
  const data = context.data
  if (data.telemetry) {
    if (span) {
      console.log("span finish")
      span.finish();
    } else {
      console.log("span start")
      span = await context.data.transaction.startChild(
        { op: op, name: name },
      );
    }
  }
}

// 采样率信号文件是「装饰性」配置，不该拖慢真正的请求。实测本地开发时它
// 单次往返能到 180s（境外域名 + 国内网络），而每个请求都要等它。
// 而且 /api/* 会先后经过 functions/_middleware.js 与 functions/api/_middleware.js，
// errorHandling 被调用两次，等于每个请求要等两趟。
// 两层防护：module 作用域缓存（成功 5 分钟、失败 1 分钟内不重试）+ 显式超时。
let cachedSampleRate = undefined;
let cachedSampleRateAt = 0;
const SAMPLE_RATE_TTL_MS = 5 * 60 * 1000;
const SAMPLE_RATE_FAILURE_TTL_MS = 60 * 1000;
const SAMPLE_RATE_TIMEOUT_MS = 1500;

async function fetchSampleRate(context) {
  const data = context.data
  if (data.telemetry) {
    const now = Date.now();
    // 失败也要缓存：否则超时后每个请求都重新等满 1.5s，翻倍叠加在响应时间上。
    const ttl = cachedSampleRate ? SAMPLE_RATE_TTL_MS : SAMPLE_RATE_FAILURE_TTL_MS;
    if (cachedSampleRate !== undefined && now - cachedSampleRateAt < ttl) {
      return cachedSampleRate;
    }
    try {
      const url = "https://frozen-sentinel.pages.dev/signal/sampleRate.json";
      const response = await fetch(url, { signal: AbortSignal.timeout(SAMPLE_RATE_TIMEOUT_MS) });
      const json = await response.json();
      cachedSampleRate = json.rate ?? null;
    } catch (e) {
      cachedSampleRate = null;
    }
    cachedSampleRateAt = Date.now();
    return cachedSampleRate;
  }
}