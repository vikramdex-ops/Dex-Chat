package in.co.dexteritydesign.connect;

import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import java.util.Locale;

/**
 * What keeps notifications arriving without Google push, and the settings pages that change it:
 * the notification permission, the battery-optimisation exemption, and the "autostart" or
 * "background activity" switches that Xiaomi, Vivo, Oppo, Realme, OnePlus, Samsung and Huawei
 * phones add on top of Android. Those makers' pages have no public API: they are opened by name
 * where the phone has them, and the app's own settings page otherwise.
 */
final class DeviceHealth {
    private DeviceHealth() {}

    /** Known autostart / background pages, most specific first, per maker. */
    private static final String[][] AUTOSTART = {
        // Xiaomi, Redmi, POCO (MIUI, HyperOS)
        { "xiaomi", "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
        { "xiaomi", "com.miui.securitycenter", "com.miui.powercenter.PowerSettings" },
        // Vivo, iQOO (Funtouch OS, OriginOS)
        { "vivo", "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
        { "vivo", "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager" },
        { "vivo", "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity" },
        // Oppo, Realme (ColorOS, realme UI) and OnePlus phones on ColorOS
        { "oppo", "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
        { "oppo", "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity" },
        { "oppo", "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity" },
        { "oppo", "com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity" },
        // OnePlus (OxygenOS)
        { "oneplus", "com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity" },
        // Samsung (One UI): Battery, where "Background usage limits" holds "Never sleeping apps"
        { "samsung", "com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity" },
        { "samsung", "com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity" },
        // Huawei, Honor (EMUI, MagicOS)
        { "huawei", "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
        { "huawei", "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity" },
    };

    /** The maker family whose extra settings apply ("xiaomi", "vivo", "oppo", "oneplus", "samsung", "huawei") or "". */
    static String maker() {
        String m = (Build.MANUFACTURER + " " + Build.BRAND).toLowerCase(Locale.ROOT);
        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) return "xiaomi";
        if (m.contains("vivo") || m.contains("iqoo")) return "vivo";
        if (m.contains("oneplus")) return "oneplus";
        if (m.contains("oppo") || m.contains("realme")) return "oppo";
        if (m.contains("samsung")) return "samsung";
        if (m.contains("huawei") || m.contains("honor")) return "huawei";
        return "";
    }

    private static boolean resolves(Context ctx, Intent i) {
        try { return ctx.getPackageManager().resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY) != null; } catch (Exception e) { return false; }
    }

    /** The maker's autostart page on this phone, or null. */
    static Intent autostartIntent(Context ctx) {
        String maker = maker();
        // OnePlus phones on ColorOS use Oppo's pages
        for (String[] row : AUTOSTART) {
            if (!row[0].equals(maker) && !(maker.equals("oneplus") && row[0].equals("oppo"))) continue;
            Intent i = new Intent().setComponent(new ComponentName(row[1], row[2])).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (resolves(ctx, i)) return i;
        }
        return null;
    }

    static boolean batteryExempt(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    /** "Restricted" background use (Android 9+), which stops the service whatever else is set. */
    static boolean backgroundRestricted(Context ctx) {
        if (Build.VERSION.SDK_INT < 28) return false;
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        return am != null && am.isBackgroundRestricted();
    }

    static Intent appDetails(Context ctx) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    static Intent notificationSettings(Context ctx) {
        if (Build.VERSION.SDK_INT >= 26) {
            return new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        }
        return appDetails(ctx);
    }

    /** The system's "Allow Dexterity Connect to always run in the background?" question. */
    static Intent batteryRequest(Context ctx) {
        return new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /** The list of apps and their battery optimisation, for when the question was already answered. */
    static Intent batteryList() {
        return new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /** Open a settings page: the first of the candidates that this phone has. Returns which one opened. */
    static String open(Context ctx, String target) {
        Intent[] candidates;
        switch (target) {
            case "notifications": candidates = new Intent[] { notificationSettings(ctx), appDetails(ctx) }; break;
            case "battery": candidates = new Intent[] { batteryExempt(ctx) ? batteryList() : batteryRequest(ctx), batteryList(), appDetails(ctx) }; break;
            case "autostart": { Intent a = autostartIntent(ctx); candidates = a != null ? new Intent[] { a, appDetails(ctx) } : new Intent[] { appDetails(ctx) }; break; }
            default: candidates = new Intent[] { appDetails(ctx) };
        }
        for (Intent i : candidates) {
            if (!resolves(ctx, i)) continue;
            try {
                ctx.startActivity(i);
                return i.getComponent() != null ? "maker" : i.getAction() != null && i.getAction().equals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS) ? "app" : target;
            } catch (Exception ignored) {
                // some makers' pages exist but refuse outside callers; try the next
            }
        }
        return null;
    }
}
