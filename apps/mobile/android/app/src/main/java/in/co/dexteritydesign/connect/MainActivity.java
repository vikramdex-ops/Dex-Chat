package in.co.dexteritydesign.connect;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DexNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
