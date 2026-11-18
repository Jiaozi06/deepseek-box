import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.jiaozi.deepseekbox',
  appName: 'DeepSeek Box',
  webDir: 'release/app/dist/renderer',
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
}

export default config
