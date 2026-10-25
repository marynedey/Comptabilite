package io.github.marynedey.comptes;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Module natif de l'appli (sauvegarde, mises à jour) : à déclarer avant le démarrage du pont.
        registerPlugin(MesComptesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
