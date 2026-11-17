package in.co.dexteritydesign.connect;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Starts the background connection again after the phone restarts and after the app is updated
 * (Android stops the old version's service), if the person had "Stay connected in the
 * background" on. Both broadcasts are among the few from which Android still allows a
 * foreground service to start.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        if (!HubService.prefs(ctx).getBoolean("keepAlive", false)) return;
        HubService.start(ctx, null);
    }
}
