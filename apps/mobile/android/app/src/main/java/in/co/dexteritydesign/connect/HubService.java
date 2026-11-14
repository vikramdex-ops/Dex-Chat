package in.co.dexteritydesign.connect;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Keeps the app's process (and so its connection to the office hub) alive while the app is in
 * the background, so messages and calls still arrive. There is no cloud push service on the
 * office network: this quiet, ongoing notification is how Android allows that.
 */
public class HubService extends Service {
    static final String CHANNEL = "connection";
    static final int ID = 4701;

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Connection to the office", NotificationManager.IMPORTANCE_MIN);
        ch.setDescription("Shown while Dexterity Connect stays connected in the background.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel(this);
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "Connected to the office";
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_dex)
            .setContentTitle("Dexterity Connect")
            .setContentText(text)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
            else startForeground(ID, n);
        } catch (Exception e) {
            // Android refuses a foreground service started from the background; try again next time
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
