export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/hello") {
      const cf = request.cf ?? {};
      return Response.json({
        message: "你好，来自 Cloudflare 边缘节点",
        colo: cf.colo ?? "unknown",
        city: cf.city ?? null,
        country: cf.country ?? null,
        time: new Date().toISOString(),
      });
    }

    return env.ASSETS.fetch(request);
  },
};
