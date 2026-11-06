// Packages the built app as a folder containing ThickShake.exe under release/.
import { packager } from '@electron/packager';
import { resolve } from 'node:path';

const paths = await packager({
  dir: resolve('.'),
  out: resolve('release'),
  name: 'ThickShake',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  asar: true,
  icon: resolve('build/icon.ico'),
  appCopyright: 'ThickShake',
  win32metadata: { CompanyName: 'ThickShake', FileDescription: 'ThickShake 3D', ProductName: 'ThickShake' },
  ignore: [/^\/src($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/release($|\/)/, /^\/\.claude($|\/)/, /^\/build($|\/)/, /^\/index\.html$/, /^\/vite\.config\.ts$/, /^\/tsconfig\.json$/, /^\/README\.md$/],
});
console.log('Packaged:', paths.join(', '));
