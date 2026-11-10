// publik's builder check: `PUBLIK_SELF_TEST=1 npm start` prints one line and exits.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.PUBLIK_SELF_TEST) {
    const { selfTest } = await import("./lib/publik");
    console.log(await selfTest());
    process.exit(0);
  }
}
