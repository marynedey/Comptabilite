package io.github.marynedey.comptes;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Pattern;

/**
 * Fonctions natives de l'appli, appelées par js/app.js (Capacitor.nativePromise('MesComptes', …)).
 * Volontairement limitées : écrire une sauvegarde dans Téléchargements, installer une mise à jour
 * venue du site de l'app. Rien d'autre n'est accessible au JavaScript.
 */
@CapacitorPlugin(name = "MesComptes")
public class MesComptesPlugin extends Plugin {

    /** Seul nom de fichier accepté : celui que fabrique sauvegarder() (js/app.js). */
    static final Pattern NOM_SAUVEGARDE = Pattern.compile("comptes_\\d{4}-\\d{2}-\\d{2}_\\d{2}h\\d{2}m\\d{2}s?\\.sqlite");
    /** Les mises à jour ne viennent que du site de l'app. */
    static final Pattern ADRESSE_MAJ = Pattern.compile("https://marynedey\\.github\\.io/Comptabilite/android/[A-Za-z0-9._-]+\\.apk");

    /** Écrit la base (base64) dans le dossier Téléchargements du téléphone. */
    @PluginMethod
    public void enregistrer(PluginCall call) {
        String nom = call.getString("nom", "");
        String donnees = call.getString("donnees");
        if (!NOM_SAUVEGARDE.matcher(nom).matches() || donnees == null) {
            call.reject("Nom de sauvegarde refusé : " + nom);
            return;
        }
        execute(() -> {
            ContentResolver cr = getContext().getContentResolver();
            Uri uri = null;
            try {
                byte[] octets = Base64.decode(donnees, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, nom);
                // octet-stream : Android garde le nom tel quel (sans ajouter d'extension)
                v.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IllegalStateException("Téléchargements inaccessible");
                try (OutputStream out = cr.openOutputStream(uri)) {
                    out.write(octets);
                }
                v.clear();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                cr.update(uri, v, null, null);
                JSObject r = new JSObject();
                r.put("dossier", "Téléchargements");
                call.resolve(r);
            } catch (Exception e) {
                if (uri != null) cr.delete(uri, null, null);
                call.reject("Échec de l'écriture : " + e.getMessage());
            }
        });
    }

    /** Android autorise-t-il l'appli à installer ses mises à jour ? (réglage « sources inconnues ») */
    @PluginMethod
    public void peutInstaller(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ok", getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    /** Ouvre le réglage d'Android qui autorise l'appli à installer ses mises à jour. */
    @PluginMethod
    public void autoriserInstallation(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /**
     * Télécharge la nouvelle version (APK) puis ouvre l'installeur d'Android, qui demande confirmation.
     * Android refuse d'installer un APK qui n'est pas signé par la même clé que l'appli installée.
     */
    @PluginMethod
    public void installer(PluginCall call) {
        String adresse = call.getString("url", "");
        if (!ADRESSE_MAJ.matcher(adresse).matches()) {
            call.reject("Adresse de mise à jour refusée : " + adresse);
            return;
        }
        execute(() -> {
            HttpURLConnection c = null;
            try {
                File dossier = new File(getContext().getCacheDir(), "maj");
                dossier.mkdirs();
                File apk = new File(dossier, "mes-comptes.apk");
                c = (HttpURLConnection) new URL(adresse).openConnection();
                c.setInstanceFollowRedirects(false); // rester sur le site de l'app
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                if (c.getResponseCode() != 200) throw new IllegalStateException("réponse " + c.getResponseCode());
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                    byte[] tampon = new byte[64 * 1024];
                    for (int n; (n = in.read(tampon)) > 0; ) out.write(tampon, 0, n);
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
            } catch (Exception e) {
                call.reject("Échec du téléchargement : " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }
}
