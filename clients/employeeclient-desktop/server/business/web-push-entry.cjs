// Reproducible server dependency entry; no credentials are compiled into it.
module.exports={...require('web-push'),WebPushProxyAgent:require('https-proxy-agent').HttpsProxyAgent};
