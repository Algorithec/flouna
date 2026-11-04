package com.flouna.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Set;

public class MainActivity extends Activity {
    private static final String ORIGIN = "https://www.flouna.com";
    private static final String OFFLINE_PAGE = "file:///android_asset/offline.html";
    private static final Set<String> SITE = Collections.singleton(ORIGIN);
    private static final int REQUEST_FILE = 1;
    private static final int REQUEST_LOCATION = 2;
    private static final int REQUEST_MIC = 3;

    private SpeechRecognizer recognizer;
    private JavaScriptReplyProxy speechReply;
    private String speechLang = "";
    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> pendingFiles;
    private GeolocationPermissions.Callback pendingLocation;
    private String pendingLocationOrigin;
    // A card payment passes through the bank's own pages, on any address, and has
    // to stay in the app to come back with a result.
    private boolean inCheckout;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.background));
        root = new FrameLayout(this);
        root.addView(web);
        setContentView(root);
        fitBetweenSystemBars();
        configure();
        handleBack();
        if (saved != null) web.restoreState(saved);
        if (saved == null || web.getUrl() == null) web.loadUrl(startUrl(getIntent()));
    }

    // Android 15 and later draw the app behind the bars and the keyboard. The
    // space goes on a parent because a WebView ignores its own padding.
    private void fitBetweenSystemBars() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars()
                            | WindowInsets.Type.ime()
                            | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    private void configure() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // The site reads this to leave out what only works in a full browser.
        settings.setUserAgentString(settings.getUserAgentString() + " FlounaAndroid/" + BuildConfig.VERSION_NAME);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        installBridge();
    }

    private void installBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            return;
        }
        WebViewCompat.addWebMessageListener(web, "FlounaApp", SITE, (view, message, origin, isMainFrame, reply) -> {
            speechReply = reply;
            if (isMainFrame && message.getData() != null) onSiteMessage(message.getData());
        });
        WebViewCompat.addDocumentStartJavaScript(web, readAsset("bridge.js"), SITE);
    }

    private void onSiteMessage(String raw) {
        try {
            JSONObject message = new JSONObject(raw);
            String type = message.optString("type");
            if ("share".equals(type)) {
                share(message.optString("title"), message.optString("text"));
            } else if ("download".equals(type)) {
                save(message.optString("name"), message.optString("mime"), message.optString("data"));
            } else if ("speech-start".equals(type)) {
                startListening(message.optString("lang"));
            } else if ("speech-stop".equals(type)) {
                if (recognizer != null) recognizer.stopListening();
            } else if ("speech-abort".equals(type)) {
                if (recognizer != null) recognizer.cancel();
            }
        } catch (JSONException ignored) {
            // Only the site's own script writes here; a bad message changes nothing.
        }
    }

    private void share(String title, String text) {
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
        if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        startActivity(Intent.createChooser(send, title.isEmpty() ? null : title));
    }

    private void save(String name, String mime, String base64) {
        // The name comes from the page, so it can't be allowed to pick a folder.
        String file = name.replaceAll("[/\\\\]", "_");
        if (file.isEmpty()) file = "flouna-download";
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, file);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("No download location");
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) throw new IOException("No download location");
                    out.write(bytes);
                }
            } else {
                File folder = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                try (OutputStream out = new FileOutputStream(new File(folder, file))) {
                    out.write(bytes);
                }
            }
            Toast.makeText(this, "Saved to Downloads: " + file, Toast.LENGTH_LONG).show();
        } catch (IOException | IllegalArgumentException e) {
            Toast.makeText(this, "Couldn't save " + file, Toast.LENGTH_LONG).show();
        }
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private String startUrl(Intent intent) {
        Uri link = intent == null ? null : intent.getData();
        if (link != null && isSite(link)) return link.toString();
        return getString(R.string.launch_url);
    }

    private static boolean isSite(Uri uri) {
        return "https".equals(uri.getScheme()) && "www.flouna.com".equals(uri.getHost());
    }

    private static boolean isCashfree(Uri uri) {
        String host = uri.getHost();
        return "https".equals(uri.getScheme()) && host != null && host.endsWith(".cashfree.com");
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if (isSite(uri) || OFFLINE_PAGE.equals(uri.toString())) {
                inCheckout = false;
                return false;
            }
            if ("https".equals(scheme) && (inCheckout || isCashfree(uri))) {
                inCheckout = true;
                return false;
            }
            openOutside(uri);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            CookieManager.getInstance().flush();
            matchBarsToPage();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && !OFFLINE_PAGE.equals(request.getUrl().toString())) {
                view.loadUrl(OFFLINE_PAGE);
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Without this the system closes the whole app with the page.
            recreate();
            return true;
        }
    }

    // UPI apps, phone, mail and any other site open in their own apps. An intent
    // address comes from the page, so it may only reach what a browser could.
    private void openOutside(Uri uri) {
        try {
            Intent intent;
            if ("intent".equals(uri.getScheme())) {
                intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, uri);
            }
            startActivity(intent);
        } catch (ActivityNotFoundException | URISyntaxException e) {
            Toast.makeText(this, "No app on this phone can open that", Toast.LENGTH_LONG).show();
        }
    }

    // The site has its own dark mode, so the bars follow the page rather than the
    // phone's setting.
    private void matchBarsToPage() {
        web.evaluateJavascript("getComputedStyle(document.body).backgroundColor", value -> {
            if (value == null) return;
            java.util.regex.Matcher rgb = java.util.regex.Pattern
                    .compile("rgba?\\((\\d+), (\\d+), (\\d+)(, 1)?\\)").matcher(value);
            if (!rgb.find()) return;
            int r = Integer.parseInt(rgb.group(1));
            int g = Integer.parseInt(rgb.group(2));
            int b = Integer.parseInt(rgb.group(3));
            int color = Color.rgb(r, g, b);
            boolean light = (r * 299 + g * 587 + b * 114) / 1000 > 128;
            web.setBackgroundColor(color);
            root.setBackgroundColor(color);
            getWindow().setStatusBarColor(color);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowInsetsController bars = getWindow().getInsetsController();
                if (bars != null) {
                    bars.setSystemBarsAppearance(
                            light ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0,
                            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
                }
            } else {
                View decor = getWindow().getDecorView();
                int flags = decor.getSystemUiVisibility();
                decor.setSystemUiVisibility(light
                        ? flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                        : flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            }
        });
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingFiles != null) pendingFiles.onReceiveValue(null);
            pendingFiles = callback;
            try {
                startActivityForResult(params.createIntent(), REQUEST_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                pendingFiles = null;
                return false;
            }
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            // Bank pages during a payment have no reason to know where anyone is.
            if (!ORIGIN.equals(origin) && !(ORIGIN + "/").equals(origin)) {
                callback.invoke(origin, false, false);
                return;
            }
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                callback.invoke(origin, true, false);
                return;
            }
            pendingLocation = callback;
            pendingLocationOrigin = origin;
            requestPermissions(new String[] {
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
            }, REQUEST_LOCATION);
        }
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        if (request == REQUEST_MIC) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                startListening(speechLang);
            } else {
                speechEvent("error", "not-allowed", false);
                speechEvent("end", "", false);
            }
            return;
        }
        if (request != REQUEST_LOCATION || pendingLocation == null) return;
        boolean granted = false;
        for (int result : results) granted |= result == PackageManager.PERMISSION_GRANTED;
        pendingLocation.invoke(pendingLocationOrigin, granted, false);
        pendingLocation = null;
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != REQUEST_FILE || pendingFiles == null) return;
        pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        pendingFiles = null;
    }

    // The offline page is in the history, but it's no place to go back to.
    private void goBackOrLeave() {
        WebBackForwardList history = web.copyBackForwardList();
        int step = -1;
        while (history.getCurrentIndex() + step >= 0
                && OFFLINE_PAGE.equals(history.getItemAtIndex(history.getCurrentIndex() + step).getUrl())) {
            step--;
        }
        if (web.canGoBackOrForward(step)) web.goBackOrForward(step);
        else finish();
    }

    // A WebView offers the web's speech API but can't run it, so bridge.js stands
    // in for that API and this does the listening.
    private void startListening(String lang) {
        speechLang = lang;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQUEST_MIC);
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            speechEvent("error", "service-not-allowed", false);
            speechEvent("end", "", false);
            return;
        }
        if (recognizer != null) recognizer.destroy();
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new Listener());
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        if (!speechLang.isEmpty()) intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, speechLang);
        recognizer.startListening(intent);
    }

    private void speechEvent(String event, String text, boolean isFinal) {
        if (speechReply == null) return;
        try {
            speechReply.postMessage(new JSONObject()
                    .put("event", event)
                    .put("text", text)
                    .put("isFinal", isFinal)
                    .toString());
        } catch (JSONException ignored) {
            // Only strings and a boolean go in, which can't fail.
        }
    }

    private final class Listener implements RecognitionListener {
        private void words(Bundle bundle, boolean isFinal) {
            ArrayList<String> heard = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (heard != null && !heard.isEmpty()) speechEvent("result", heard.get(0), isFinal);
        }

        @Override public void onPartialResults(Bundle bundle) { words(bundle, false); }

        @Override public void onResults(Bundle bundle) {
            words(bundle, true);
            speechEvent("end", "", false);
        }

        @Override public void onError(int error) {
            speechEvent("error", error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "not-allowed" : "no-speech", false);
            speechEvent("end", "", false);
        }

        @Override public void onReadyForSpeech(Bundle bundle) {}
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float level) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int type, Bundle bundle) {}
    }

    // Android 16 stops calling onBackPressed for apps that target it.
    private void handleBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBackOrLeave);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        goBackOrLeave();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) web.loadUrl(startUrl(intent));
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) recognizer.destroy();
        web.destroy();
        super.onDestroy();
    }
}
