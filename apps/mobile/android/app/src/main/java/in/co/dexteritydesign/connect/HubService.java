package in.co.dexteritydesign.connect;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Keeps Dexterity Connect connected to the office while it is in the background. There is no
 * Google push on the office network, so this foreground service, with its quiet ongoing
 * "Connected to the office" notification, is how Android allows that.
 *
 * Two things keep messages coming:
 * - While the app's WebView runs, its own connection to the hub delivers messages and the app
 *   shows notifications; this service only keeps the process alive.
 * - When the WebView is gone (Android restarted the service on its own, or after a reboot or an
 *   update) or has lost its connection, the service waits for new messages itself: a long poll to
 *   the hub's /notify/wait with a per-device token, pinned to the hub's certificate, on the office
 *   network. It shows what arrives with the person's notification preferences.
 * Whatever either missed is fetched by the app when it reconnects (see the phone bridge), so a
 * message is never silently lost, only late.
 *
 * Restarted after a reboot and after an app update by BootReceiver, and by Android itself
 * (START_STICKY) if it stops the service.
 */
public class HubService extends Service {
    static final String CHANNEL = "office_connection";
    private static final String OLD_CHANNEL = "connection";
    static final int ID = 4701;
    static final String PREFS = "dex_watch";

    /** The app's own connection is up (no need to wait separately). Set by the plugin. */
    static volatile boolean appConnected = false;
    static volatile boolean running = false;
    static volatile long lastOk = 0;
    static volatile String lastError = null;
    private static final Object WAKE = new Object();
    private Thread watcher;

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        // the first version made this channel "minimum" importance, which some makers treat as a
        // sign the service can be stopped; a channel's importance cannot change, so it is replaced
        if (nm.getNotificationChannel(OLD_CHANNEL) != null) nm.deleteNotificationChannel(OLD_CHANNEL);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Connection to the office", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while Dexterity Connect stays connected in the background. Quiet: no sound or pop-up.");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Start (or keep) the service, from the app, a reboot or an update. */
    static boolean start(Context ctx, String text) {
        Intent svc = new Intent(ctx, HubService.class);
        if (text != null) svc.putExtra("text", text);
        try {
            ContextCompat.startForegroundService(ctx, svc);
            return true;
        } catch (Exception e) {
            // Android refuses a foreground service started from the background; the next start tries again
            return false;
        }
    }

    /** Something changed (the app's connection, the settings): look again now. */
    static void poke() {
        synchronized (WAKE) { WAKE.notifyAll(); }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel(this);
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : prefs(this).getString("text", "Connected to the office");
        prefs(this).edit().putString("text", text).apply();
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_dex)
            .setContentTitle("Dexterity Connect")
            .setContentText(text)
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
            else startForeground(ID, n);
        } catch (Exception e) {
            // Android refuses a foreground service started from the background; try again next time
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        if (watcher == null || !watcher.isAlive()) {
            watcher = new Thread(this::watch, "dex-notify-watch");
            watcher.setDaemon(true);
            watcher.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (watcher != null) watcher.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ---------------------------------------------------------------- the background watcher
    private void pause(long ms) throws InterruptedException {
        synchronized (WAKE) { WAKE.wait(ms); }
    }

    private void watch() {
        OkHttpClient client;
        try { client = HubHttp.longPoll(); } catch (Exception e) { lastError = "TLS is not available"; return; }
        long backoff = 5_000;
        while (running && !Thread.currentThread().isInterrupted()) {
            try {
                SharedPreferences p = prefs(this);
                String base = p.getString("url", null);
                String fp = p.getString("fp", null);
                String token = null;
                try { token = SecureStore.get(this, "notify-token"); } catch (Exception e) { token = null; }
                if (appConnected || !p.getBoolean("on", false) || base == null || fp == null || token == null) {
                    pause(60_000);
                    continue;
                }
                String cursor = p.getString("cursor", "");
                Request req = new Request.Builder()
                    .url(base + "/notify/wait" + (cursor.isEmpty() ? "" : "?after=" + cursor))
                    .header("Authorization", "Bearer " + token)
                    .build();
                try (Response res = client.newCall(req).execute()) {
                    if (!fp.equals(HubHttp.peerFingerprint(res))) throw new Exception("The hub presented an unexpected certificate.");
                    if (res.code() == 401) {
                        // signed out or removed: wait for the app to sign in and give a new token
                        lastError = "Signed out";
                        p.edit().putBoolean("on", false).apply();
                        continue;
                    }
                    if (!res.isSuccessful() || res.body() == null) throw new Exception("HTTP " + res.code());
                    String body = res.body().string();
                    if (body.length() > 512 * 1024) throw new Exception("Response too large");
                    JSONObject json = new JSONObject(body);
                    // the app may have connected meanwhile; it shows these itself then
                    if (!appConnected) show(json.optJSONArray("items"));
                    String next = json.optString("cursor", "");
                    if (next.matches("[0-9A-Z]{26}")) p.edit().putString("cursor", next).apply();
                    lastOk = System.currentTimeMillis();
                    lastError = null;
                    backoff = 5_000;
                }
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                // off the office network, the hub restarting, Wi-Fi asleep: try again a little later
                lastError = e.getMessage() == null ? "Not reachable" : e.getMessage();
                try { pause(backoff); } catch (InterruptedException ie) { return; }
                backoff = Math.min(backoff * 2, 5 * 60_000);
            }
        }
    }

    private boolean quietNow(String from, String to) {
        if (from == null || to == null || !from.matches("\\d\\d:\\d\\d") || !to.matches("\\d\\d:\\d\\d")) return false;
        Calendar c = Calendar.getInstance();
        int t = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE);
        int a = Integer.parseInt(from.substring(0, 2)) * 60 + Integer.parseInt(from.substring(3, 5));
        int b = Integer.parseInt(to.substring(0, 2)) * 60 + Integer.parseInt(to.substring(3, 5));
        return a <= b ? t >= a && t < b : t >= a || t < b;
    }

    /** The same rules as the app (Preferences ▸ Notifications), applied to what the hub sent. */
    private void show(JSONArray items) {
        if (items == null || items.length() == 0) return;
        SharedPreferences p = prefs(this);
        String notifyFor = p.getString("notifyFor", "all");
        if ("none".equals(notifyFor) || quietNow(p.getString("quietFrom", null), p.getString("quietTo", null))) return;
        boolean previews = p.getBoolean("showPreviews", true);
        boolean silent = p.getBoolean("silent", false);
        for (int i = 0; i < items.length() && i < 20; i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            boolean personal = it.optBoolean("personal", false);
            boolean mentioned = it.optBoolean("mentioned", false);
            if (it.optBoolean("muted", false) && !mentioned) continue;
            if ("mentions".equals(notifyFor) && !personal) continue;
            String text = it.optBoolean("sealed", false) ? "New encrypted message" : it.optString("text", "");
            if (!previews) text = "New message";
            if (text.isEmpty()) text = "New message";
            Notifier.show(this, it.optString("title", "Dexterity Connect"), text, it.optString("link", "dexconnect://open"), silent);
        }
    }
}
