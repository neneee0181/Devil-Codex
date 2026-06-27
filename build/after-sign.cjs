"use strict";
// Ad-hoc code-sign the macOS app when no Apple Developer certificate is present.
// arm64 binaries MUST carry at least an ad-hoc signature or macOS rejects a
// downloaded app as "손상되었기 때문에 열 수 없습니다" (damaged). Ad-hoc signing is
// free and turns that hard block into a normal "unidentified developer" prompt
// (right-click → Open once). When a real cert is configured, electron-builder
// already signed it, so this is a no-op.
const { execFileSync } = require("node:child_process");

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK) return; // real signing already happened
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
    console.log(`  • ad-hoc signed ${appPath}`);
  } catch (error) {
    console.warn("  • ad-hoc sign failed:", error && error.message ? error.message : error);
  }
};
