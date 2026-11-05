const brand = require('../branding/brand.json');

module.exports = {
  appId: brand.appId,
  productName: brand.productName,
  copyright: 'Copyright © Samin Yasar; BrowserOS contributors',
  extraMetadata: { name: 'tandem-desktop', description: brand.description, homepage: brand.repository },
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'package.json'],
  asar: true,
  icon: 'build/icon.png',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  mac: {
    target: ['dmg', 'zip'],
    identity: process.env.CSC_LINK || process.env.CSC_NAME ? undefined : null,
    category: 'public.app-category.productivity',
    darkModeSupport: true,
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
  },
  dmg: { sign: false },
  win: { target: ['nsis'] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false },
  linux: { target: ['AppImage', 'deb'], category: 'Network', maintainer: 'Samin Yasar' }
};
