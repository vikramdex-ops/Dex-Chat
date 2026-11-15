package in.co.dexteritydesign.connect;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import java.util.concurrent.atomic.AtomicInteger;

/** Message notifications, shown by the app while it runs and by the background service on its own. */
final class Notifier {
    static final String MESSAGES = "messages";
    static final String MESSAGES_QUIET = "messages_quiet";
    private static final AtomicInteger NEXT = new AtomicInteger(100);

    private Notifier() {}

    static boolean allowed(Context ctx) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return false;
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled();
    }

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(MESSAGES) == null) {
            NotificationChannel ch = new NotificationChannel(MESSAGES, "Messages and reminders", NotificationManager.IMPORTANCE_HIGH);
            ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT).build());
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(MESSAGES_QUIET) == null) {
            NotificationChannel ch = new NotificationChannel(MESSAGES_QUIET, "Messages without sound", NotificationManager.IMPORTANCE_HIGH);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
    }

    /** Is the messages channel switched off in Android's settings? */
    static boolean messagesBlocked(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return false;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel ch = nm == null ? null : nm.getNotificationChannel(MESSAGES);
        return ch != null && ch.getImportance() == NotificationManager.IMPORTANCE_NONE;
    }

    /** A message, reminder or meeting notification; tapping it opens the given dexconnect:// link. */
    static void show(Context ctx, String title, String body, String link, boolean silent) {
        if (!allowed(ctx)) return;
        ensureChannels(ctx);
        if (link == null || !link.startsWith("dexconnect://")) link = "dexconnect://open";
        Intent open = new Intent(ctx, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(link))
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        int id = NEXT.getAndIncrement();
        PendingIntent pi = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, silent ? MESSAGES_QUIET : MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_dex)
            .setColor(0xFF1C7680)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setGroup(link)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH);
        if (silent) b.setSilent(true);
        try {
            NotificationManagerCompat.from(ctx).notify(link, id, b.build());
        } catch (SecurityException e) {
            // notifications were turned off for the app
        }
    }
}
