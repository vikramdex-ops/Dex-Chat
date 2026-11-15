package in.co.dexteritydesign.connect;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Response;

/**
 * HTTPS to the office hub's self-issued certificate: any certificate is accepted at the TLS layer
 * and then checked against the SHA-256 fingerprint the app pinned on first contact.
 */
final class HubHttp {
    private HubHttp() {}

    static OkHttpClient.Builder pinnedBuilder() throws Exception {
        X509TrustManager acceptAll = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) {}
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[] { acceptAll }, new SecureRandom());
        return new OkHttpClient.Builder()
            .sslSocketFactory(ctx.getSocketFactory(), acceptAll)
            .hostnameVerifier((host, session) -> true)
            .followRedirects(false);
    }

    /** Same format as Node's X509Certificate.fingerprint256: upper-case hex pairs joined by ':'. */
    static String fingerprint(Certificate cert) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < d.length; i++) {
            if (i > 0) sb.append(':');
            sb.append(String.format("%02X", d[i]));
        }
        return sb.toString();
    }

    static String peerFingerprint(Response res) throws Exception {
        if (res.handshake() == null || res.handshake().peerCertificates().isEmpty()) return "";
        return fingerprint(res.handshake().peerCertificates().get(0));
    }

    static OkHttpClient longPoll() throws Exception {
        return pinnedBuilder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(75, TimeUnit.SECONDS).build();
    }
}
