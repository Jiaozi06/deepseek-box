import { Capacitor, registerPlugin } from '@capacitor/core'

type NativeDeviceBridge = {
  speak(options: { text: string; language?: string }): Promise<void>
  stop(): Promise<void>
  writeClipboard(options: { text: string }): Promise<void>
  startListening(): Promise<{ text: string }>
  stopListening(): Promise<void>
}

const NativeDevice = registerPlugin<NativeDeviceBridge>('NativeDevice')

export async function speakText(text: string) {
  if (Capacitor.isNativePlatform()) {
    await NativeDevice.speak({ text, language: /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US' })
    return
  }
  const speech = window.speechSynthesis
  if (!speech) throw new Error('当前设备不支持朗读')
  await new Promise<void>((resolve, reject) => {
    speech.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
    utterance.onend = () => resolve()
    utterance.onerror = () => reject(new Error('朗读失败'))
    speech.speak(utterance)
  })
}

export async function stopSpeaking() {
  if (Capacitor.isNativePlatform()) await NativeDevice.stop()
  else window.speechSynthesis?.cancel()
}

export async function copyText(text: string) {
  if (Capacitor.isNativePlatform()) await NativeDevice.writeClipboard({ text })
  else await navigator.clipboard.writeText(text)
}

export async function listenForSpeech() {
  if (!Capacitor.isNativePlatform()) throw new Error('语音输入仅在 Android 版本中可用')
  return NativeDevice.startListening()
}
