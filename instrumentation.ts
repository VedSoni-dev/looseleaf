// Start-up hook (Next calls register() once when the server starts). With PUBLIK_SELF_TEST set, the built
// app proves its publik wiring and exits: `npm run build && PUBLIK_SELF_TEST=1 npm run start` prints
// `publik self-test: ok <slug> <version>` (or `publik self-test: failed: <message>`).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.PUBLIK_SELF_TEST) return;
  if (process.env.NEXT_PHASE === "phase-production-build") return; // never during `next build`
  const { runSelfTest } = await import("./lib/publik");
  await runSelfTest();
}
