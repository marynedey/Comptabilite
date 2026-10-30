package io.github.marynedey.comptes;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
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
 * Volontairement limitées : écrire une sauvegarde dans Téléchargements ou dans le dossier choisi par
 * la personne (fenêtre d'Android), installer une mise à jour venue du site de l'app, demander à Android
 * de confirmer l'identité (empreinte, visage ou code du téléphone) pour le verrouillage. Le JavaScript ne
 * peut ni lister, ni lire, ni supprimer de fichier, ni écrire ailleurs.
 */
@CapacitorPlugin(name = "MesComptes")
public class MesComptesPlugin extends Plugin {

    /** Seul nom de fichier accepté : celui que fabrique sauvegarder() (js/app.js). */
    static final Pattern NOM_SAUVEGARDE = Pattern.compile("comptes_\\d{4}-\\d{2}-\\d{2}_\\d{2}h\\d{2}m\\d{2}s?\\.sqlite");
    /** Les mises à jour ne viennent que du site de l'app. */
    static final Pattern ADRESSE_MAJ = Pattern.compile("https://marynedey\\.github\\.io/Comptabilite/android/[A-Za-z0-9._-]+\\.apk");

    /** Verrouillage : empreinte ou visage, ou à défaut le code / schéma du téléphone (valable dès Android 10). */
    static final int AUTORISES = BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    /** Réglage de cet appareil : dossier choisi pour les sauvegardes (adresse donnée par Android). */
    private SharedPreferences reglages() {
        return getContext().getSharedPreferences("reglages", Context.MODE_PRIVATE);
    }

    /** Dossier choisi, s'il est toujours autorisé ; sinon null (= Téléchargements). */
    private Uri dossierChoisi() {
        String d = reglages().getString("dossier", null);
        if (d == null) return null;
        Uri uri = Uri.parse(d);
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions())
            if (p.getUri().equals(uri) && p.isWritePermission()) return uri;
        return null;
    }

    private String nomDuDossier(Uri arbre) {
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(arbre, DocumentsContract.getTreeDocumentId(arbre));
        try (Cursor c = getContext().getContentResolver().query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception e) { /* nom inconnu */ }
        return "dossier choisi";
    }

    /** Nom du dossier choisi pour les sauvegardes, ou rien (Téléchargements). */
    @PluginMethod
    public void dossier(PluginCall call) {
        JSObject r = new JSObject();
        Uri d = dossierChoisi();
        if (d != null) r.put("nom", nomDuDossier(d));
        call.resolve(r);
    }

    /** Ouvre la fenêtre d'Android pour choisir le dossier des sauvegardes. */
    @PluginMethod
    public void choisirDossier(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "dossierChoisi");
    }

    @ActivityCallback
    private void dossierChoisi(PluginCall call, ActivityResult resultat) {
        JSObject r = new JSObject();
        Intent data = resultat.getData();
        if (resultat.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(r); // fenêtre fermée sans choisir : rien ne change
            return;
        }
        Uri uri = data.getData();
        ContentResolver cr = getContext().getContentResolver();
        try {
            cr.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) {
            call.reject("Android ne permet pas d'écrire dans ce dossier : " + e.getMessage());
            return;
        }
        oublierAutorisation(uri);
        reglages().edit().putString("dossier", uri.toString()).apply();
        r.put("nom", nomDuDossier(uri));
        call.resolve(r);
    }

    /** Retire l'autorisation d'Android sur l'ancien dossier (sauf celui qu'on garde). */
    private void oublierAutorisation(Uri garder) {
        String d = reglages().getString("dossier", null);
        if (d == null || (garder != null && garder.toString().equals(d))) return;
        try {
            getContext().getContentResolver().releasePersistableUriPermission(Uri.parse(d), Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception e) { /* déjà retirée */ }
    }

    /** Retour aux Téléchargements. */
    @PluginMethod
    public void oublierDossier(PluginCall call) {
        oublierAutorisation(null);
        reglages().edit().remove("dossier").apply();
        call.resolve();
    }

    /**
     * Écrit la base (base64) : dans le dossier choisi si « dossier » est vrai (refus si ce dossier
     * n'est plus accessible : le JavaScript propose alors Téléchargements), sinon dans Téléchargements.
     */
    @PluginMethod
    public void enregistrer(PluginCall call) {
        String nom = call.getString("nom", "");
        String donnees = call.getString("donnees");
        if (!NOM_SAUVEGARDE.matcher(nom).matches() || donnees == null) {
            call.reject("Nom de sauvegarde refusé : " + nom);
            return;
        }
        if (call.getBoolean("dossier", false)) {
            Uri arbre = dossierChoisi();
            if (arbre == null) {
                call.reject("le dossier choisi n'est plus autorisé");
                return;
            }
            execute(() -> {
                ContentResolver cr = getContext().getContentResolver();
                try {
                    byte[] octets = Base64.decode(donnees, Base64.DEFAULT);
                    Uri parent = DocumentsContract.buildDocumentUriUsingTree(arbre, DocumentsContract.getTreeDocumentId(arbre));
                    Uri doc = DocumentsContract.createDocument(cr, parent, "application/octet-stream", nom);
                    if (doc == null) throw new IllegalStateException("création du fichier refusée");
                    try (OutputStream out = cr.openOutputStream(doc, "w")) {
                        out.write(octets);
                    }
                    JSObject r = new JSObject();
                    r.put("dossier", nomDuDossier(arbre));
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
                }
            });
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

    /** Le téléphone a-t-il un verrouillage d'écran (empreinte, visage, code, schéma) pour confirmer l'identité ? */
    @PluginMethod
    public void verrouDisponible(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ok", BiometricManager.from(getContext()).canAuthenticate(AUTORISES) == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(r);
    }

    /**
     * Fenêtre d'Android qui demande l'empreinte, le visage ou le code du téléphone.
     * Résultat : { ok: true } si l'identité est confirmée ; sinon { ok: false, message } (annulé, trop d'essais…).
     * L'appli ne voit jamais l'empreinte ni le code : seul Android les vérifie.
     */
    @PluginMethod
    public void deverrouiller(PluginCall call) {
        String titre = call.getString("titre", "Mes comptes");
        if (titre == null || titre.isEmpty() || titre.length() > 60) titre = "Mes comptes";
        final String t = titre;
        FragmentActivity activite = getActivity();
        activite.runOnUiThread(() -> {
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(t)
                    .setSubtitle("Empreinte, visage ou code du téléphone")
                    .setAllowedAuthenticators(AUTORISES)
                    .build();
            BiometricPrompt fenetre = new BiometricPrompt(activite, ContextCompat.getMainExecutor(getContext()),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult resultat) {
                            JSObject r = new JSObject();
                            r.put("ok", true);
                            call.resolve(r);
                        }

                        @Override
                        public void onAuthenticationError(int code, CharSequence message) {
                            JSObject r = new JSObject();
                            r.put("ok", false);
                            r.put("code", code);
                            r.put("message", message != null ? message.toString() : "");
                            call.resolve(r);
                        }
                        // onAuthenticationFailed : un essai raté, la fenêtre reste ouverte pour réessayer
                    });
            fenetre.authenticate(info);
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
