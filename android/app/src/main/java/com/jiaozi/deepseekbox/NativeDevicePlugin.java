package com.jiaozi.deepseekbox;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PluginCall;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.ArrayList;

@CapacitorPlugin(name = "NativeDevice", permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class NativeDevicePlugin extends Plugin implements TextToSpeech.OnInitListener {
    private TextToSpeech textToSpeech;
    private boolean initialized = false;
    private PluginCall pendingCall;
    private String pendingText;
    private String pendingLanguage;
    private final Map<String, PluginCall> activeCalls = new HashMap<>();
    private SpeechRecognizer speechRecognizer;
    private PluginCall speechCall;

    @Override
    public void load() {
        textToSpeech = new TextToSpeech(getContext(), this);
    }

    @Override
    public void onInit(int status) {
        initialized = status == TextToSpeech.SUCCESS;
        if (!initialized) {
            if (pendingCall != null) pendingCall.reject("系统语音引擎初始化失败");
            pendingCall = null;
            return;
        }
        textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {}

            @Override
            public void onDone(String utteranceId) {
                resolveUtterance(utteranceId, null);
            }

            @Override
            public void onError(String utteranceId) {
                resolveUtterance(utteranceId, "系统语音播放失败");
            }
        });
        if (pendingCall != null) {
            PluginCall call = pendingCall;
            String text = pendingText;
            String language = pendingLanguage;
            pendingCall = null;
            pendingText = null;
            pendingLanguage = null;
            speakNow(call, text, language);
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String language = call.getString("language", "zh-CN");
        if (text == null || text.trim().isEmpty()) {
            call.reject("没有可朗读的内容");
            return;
        }
        if (textToSpeech == null) {
            call.reject("系统语音引擎不可用");
            return;
        }
        if (!initialized) {
            if (pendingCall != null) pendingCall.reject("朗读请求已被新的请求替代");
            pendingCall = call;
            pendingText = text;
            pendingLanguage = language;
            return;
        }
        speakNow(call, text, language);
    }

    private void speakNow(PluginCall call, String text, String language) {
        Locale locale = Locale.forLanguageTag(language == null ? "zh-CN" : language);
        int available = textToSpeech.isLanguageAvailable(locale);
        if (available < TextToSpeech.LANG_AVAILABLE) {
            locale = Locale.getDefault();
            available = textToSpeech.isLanguageAvailable(locale);
        }
        if (available < TextToSpeech.LANG_AVAILABLE) {
            call.reject("设备没有可用的语音语言包，请在系统设置中安装中文语音");
            return;
        }
        textToSpeech.setLanguage(locale);
        String id = UUID.randomUUID().toString();
        activeCalls.put(id, call);
        int result = textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
        if (result == TextToSpeech.ERROR) {
            activeCalls.remove(id);
            call.reject("系统语音播放失败，请检查设备的文字转语音设置");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (textToSpeech != null) textToSpeech.stop();
        for (PluginCall activeCall : activeCalls.values()) activeCall.resolve(new JSObject());
        activeCalls.clear();
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void writeClipboard(PluginCall call) {
        String text = call.getString("text", "");
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            call.reject("系统剪贴板不可用");
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("DeepSeek Box", text == null ? "" : text));
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("此设备没有可用的语音识别服务");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "startListeningAfterPermission");
            return;
        }
        beginListening(call);
    }

    @PermissionCallback
    private void startListeningAfterPermission(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("需要麦克风权限才能语音输入");
            return;
        }
        beginListening(call);
    }

    private void beginListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (speechRecognizer != null) speechRecognizer.destroy();
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            speechCall = call;
            speechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(android.os.Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onPartialResults(android.os.Bundle partialResults) {}
                @Override public void onEvent(int eventType, android.os.Bundle params) {}

                @Override
                public void onError(int error) {
                    finishSpeech(null, "语音识别失败，请重试");
                }

                @Override
                public void onResults(android.os.Bundle results) {
                    ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    finishSpeech(matches == null || matches.isEmpty() ? "" : matches.get(0), null);
                }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            speechRecognizer.startListening(intent);
        });
    }

    private void finishSpeech(String transcript, String error) {
        getActivity().runOnUiThread(() -> {
            if (speechRecognizer != null) {
                speechRecognizer.destroy();
                speechRecognizer = null;
            }
            PluginCall call = speechCall;
            speechCall = null;
            if (call == null) return;
            if (error != null) {
                call.reject(error);
                return;
            }
            JSObject result = new JSObject();
            result.put("text", transcript == null ? "" : transcript);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (speechRecognizer != null) {
                speechRecognizer.cancel();
                speechRecognizer.destroy();
                speechRecognizer = null;
            }
            if (speechCall != null) speechCall.reject("语音输入已取消");
            speechCall = null;
            call.resolve(new JSObject());
        });
    }

    private void resolveUtterance(String utteranceId, String error) {
        getActivity().runOnUiThread(() -> {
            PluginCall call = activeCalls.remove(utteranceId);
            if (call == null) return;
            if (error == null) call.resolve(new JSObject());
            else call.reject(error);
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
        if (speechRecognizer != null) {
            speechRecognizer.cancel();
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
        if (pendingCall != null) pendingCall.reject("应用已关闭");
        for (PluginCall call : activeCalls.values()) call.reject("应用已关闭");
        activeCalls.clear();
        super.handleOnDestroy();
    }
}
