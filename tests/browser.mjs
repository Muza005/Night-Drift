// How the browser tests start Chrome.
//
//   (no flag)   no window, software rendering (SwiftShader): runs anywhere, 4-5 fps, so
//               frame rates and long tasks are not judged
//   --headed    no window either, but drawn on the real GPU (ANGLE over EGL): 60 fps, the
//               numbers that count. Nothing pops up on the screen while you work.
//   --show      a real visible window on the GPU, to watch a test run
//
// CHROME_PATH picks the Chrome binary when it is not in the standard place.
export function launchOptions(argv = process.argv, extra = []) {
  const show = argv.includes('--show'), gpu = show || argv.includes('--headed');
  const args = !gpu ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : show ? ['--ignore-gpu-blocklist']
    // (hardware video decoding in a windowless Chrome takes the GPU process down, and the
    // WebGL context with it, as soon as a home card's loop plays: software decoding here)
    : ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-accelerated-video-decode'];
  return {
    headless: !show,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [...args, ...extra],
  };
}
// true when the page is drawn on the GPU (--headed or --show)
export const onGpu = (argv = process.argv) => argv.includes('--headed') || argv.includes('--show');
