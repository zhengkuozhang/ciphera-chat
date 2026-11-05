import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./e2e',
  workers:1,
  timeout:45000,
  expect:{timeout:12000},
  use:{baseURL:'http://127.0.0.1:4174',viewport:{width:1440,height:1000},launchOptions:{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'},trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'node test/browser-server.mjs',url:'http://127.0.0.1:4174/api/health',reuseExistingServer:false}
});
