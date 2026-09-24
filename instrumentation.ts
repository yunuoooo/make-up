/**
 * Next.js 进程级初始化入口。必须在 Node.js runtime 下才起 OTel——
 * edge runtime 里没有 NodeSDK 需要的模块，也不该往那边塞。
 *
 * key 没配时 initObservability 直接返回 false：不起 SDK、不发请求、不报错。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { initObservability } = await import("./lib/observability/langfuse.ts");
    await initObservability();
  } catch (error) {
    // 观测起不来不该拦住应用启动。
    console.warn("[observability] 初始化入口失败：", error instanceof Error ? error.message : error);
  }
}
