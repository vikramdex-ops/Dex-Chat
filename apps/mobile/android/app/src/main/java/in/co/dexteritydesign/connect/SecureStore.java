package in.co.dexteritydesign.connect;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small secrets (the device keys, the background service's token) wrapped with an AES-256 key
 * that is generated inside the Android Keystore and never leaves it. Only the wrapped bytes are
 * stored, in a private preferences file the app's backups never include (allowBackup is off).
 * Each value is bound to its name, so wrapped values cannot be swapped between names.
 */
final class SecureStore {
    private static final String ALIAS = "dexconnect-secrets-v1";
    private static final String FILE = "dex_secure";

    /** The stored value exists but cannot be unwrapped any more (the Keystore key is gone). */
    static final class UnreadableException extends Exception {
        UnreadableException(Throwable cause) { super("The stored key can no longer be opened.", cause); }
    }

    private SecureStore() {}

    static boolean validName(String name) {
        return name != null && name.matches("[a-z0-9][a-z0-9-]{0,39}");
    }

    private static synchronized SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return kg.generateKey();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static void set(Context ctx, String name, String value) throws Exception {
        if (!validName(name)) throw new IllegalArgumentException("invalid name");
        SharedPreferences.Editor ed = prefs(ctx).edit();
        if (value == null) {
            ed.remove("v_" + name);
        } else {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            ed.putString("v_" + name, Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(ct, Base64.NO_WRAP));
        }
        if (!ed.commit()) throw new Exception("Could not save");
    }

    /** The value, or null when none is stored. */
    static String get(Context ctx, String name) throws Exception {
        if (!validName(name)) throw new IllegalArgumentException("invalid name");
        String stored = prefs(ctx).getString("v_" + name, null);
        if (stored == null) return null;
        int dot = stored.indexOf('.');
        if (dot <= 0) throw new UnreadableException(null);
        SecretKey k;
        try { k = key(); } catch (Exception e) { throw e; }
        try {
            byte[] iv = Base64.decode(stored.substring(0, dot), Base64.NO_WRAP);
            byte[] ct = Base64.decode(stored.substring(dot + 1), Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, iv));
            c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            return new String(c.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // a wrapped value from a Keystore key that no longer exists (or was changed)
            throw new UnreadableException(e);
        }
    }
}
