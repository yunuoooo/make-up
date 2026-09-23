/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Langfuse 的 OTel 依赖交给 Node 在运行时 require，不进 webpack 打包。
   * `@opentelemetry/sdk-node` → `otlp-grpc-exporter-base` → `@grpc/grpc-js` 里满是
   * `require("stream")` / `require("fs")` 这类 Node 内置模块，打进产物没有意义。
   */
  serverExternalPackages: [
    "@opentelemetry/sdk-node",
    "@langfuse/otel",
    "@langfuse/tracing",
    "@grpc/grpc-js"
  ],

  webpack: (config, { nextRuntime }) => {
    /**
     * 上面那条只作用于 Node 编译单元；edge 编译单元不认它，也没有 Node 内置模块。
     *
     * `instrumentation.ts` 的 `register()` 里有 `NEXT_RUNTIME !== "nodejs"` 守卫，
     * 动态 import 在 edge 下运行时不可达——但 webpack 只做静态分析，照样会为 edge
     * 解析整条 OTel 链，解析不到就 `Module not found: Can't resolve 'stream'`，
     * dev 下直接让服务器起不来（生产构建先做 DCE，所以只在 dev 暴露）。
     *
     * 这里把链上三个入口在 edge 下指向空模块：编译期不再跟着走，运行时也碰不到
     * （守卫先行返回）。**改 instrumentation.ts 时不要绕过那个守卫。**
     */
    if (nextRuntime === "edge") {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@opentelemetry/sdk-node": false,
        "@langfuse/otel": false,
        "@langfuse/tracing": false
      };
    }
    return config;
  }
};

export default nextConfig;
