package de.cracky.vela.core

import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.interfaces.RSAPrivateCrtKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.RSAKeyGenParameterSpec
import java.security.spec.RSAPrivateCrtKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/**
 * Kryptografie, kompatibel zum Web-Client (static/js/crypto.js):
 *  - RSA-OAEP (SHA-256) für die Schlüsselkapselung, ECDSA P-256 (SHA-256, IEEE-P1363-Signatur) für Signaturen
 *  - Nachrichten: AES-256-GCM mit AAD "vela-msg-v1|id|from|to"
 *  - Dateien: AES-256-GCM in 1-MiB-Blöcken, AAD "vela-file-v1|index|last"
 */
object Crypto {
    // Bouncy Castle für RSA-OAEP (Android-Conscrypt nutzt je nach Version SHA-1 als MGF1-Hash) und für ECDSA/EC-Schlüssel.
    private val bc = BouncyCastleProvider()
    const val FILE_CHUNK = 1 shl 20

    // ------------------------------------------------------------------ Identität
    class Identity(
        val bits: Int,
        val encPubB64: String,
        val sigPubB64: String,
        val encPriv: PrivateKey,
        val sigPriv: PrivateKey,
        /** Original-JSON (Format v2 mit JWK) – wird verschlüsselt gesichert / ins Backup und den Tresor gelegt. */
        val json: String,
    )

    private fun stripZeros(b: ByteArray): ByteArray {
        var i = 0
        while (i < b.size - 1 && b[i].toInt() == 0) i++
        return b.copyOfRange(i, b.size)
    }

    private fun BigInteger.u(): String = stripZeros(toByteArray()).b64url()
    private fun BigInteger.fixed32(): String {
        val raw = stripZeros(toByteArray())
        val out = ByteArray(32)
        System.arraycopy(raw, 0, out, 32 - raw.size, raw.size)
        return out.b64url()
    }

    private fun big(s: String) = BigInteger(1, s.unb64url())

    private fun ecSpec(): ECParameterSpec {
        val ap = AlgorithmParameters.getInstance("EC", bc)
        ap.init(ECGenParameterSpec("secp256r1"))
        return ap.getParameterSpec(ECParameterSpec::class.java)
    }

    /** Erzeugt ein neues Schlüsselpaar-Set (RSA + ECDSA). Rechenintensiv – nicht im UI-Thread aufrufen. */
    fun generateIdentity(bits: Int): Identity {
        val rg = KeyPairGenerator.getInstance("RSA")
        rg.initialize(RSAKeyGenParameterSpec(bits, RSAKeyGenParameterSpec.F4))
        val rsa = rg.generateKeyPair()
        val eg = KeyPairGenerator.getInstance("EC", bc)
        eg.initialize(ECGenParameterSpec("secp256r1"))
        val ec = eg.generateKeyPair()
        val rp = rsa.private as RSAPrivateCrtKey
        val ep = ec.private as ECPrivateKey
        val ew = (ec.public as ECPublicKey).w
        val encJwk = JSONObject()
            .put("kty", "RSA").put("n", rp.modulus.u()).put("e", rp.publicExponent.u()).put("d", rp.privateExponent.u())
            .put("p", rp.primeP.u()).put("q", rp.primeQ.u()).put("dp", rp.primeExponentP.u())
            .put("dq", rp.primeExponentQ.u()).put("qi", rp.crtCoefficient.u())
            .put("alg", "RSA-OAEP-256").put("ext", true)
        val sigJwk = JSONObject()
            .put("kty", "EC").put("crv", "P-256").put("d", ep.s.fixed32())
            .put("x", ew.affineX.fixed32()).put("y", ew.affineY.fixed32()).put("ext", true)
        val json = JSONObject().put("v", 2).put("bits", bits)
            .put("encPub", rsa.public.encoded.b64()).put("sigPub", ec.public.encoded.b64())
            .put("encJwk", encJwk).put("sigJwk", sigJwk).toString()
        return parseIdentity(json)
    }

    /** Liest eine Identität im Format v2 (JWK) oder v1 (PKCS#8). */
    fun parseIdentity(json: String): Identity {
        val o = JSONObject(json)
        val encPub = o.getString("encPub")
        val sigPub = o.getString("sigPub")
        val rsaKf = KeyFactory.getInstance("RSA", bc)
        val ecKf = KeyFactory.getInstance("EC", bc)
        val encJwk = o.optJSONObject("encJwk")
        val sigJwk = o.optJSONObject("sigJwk")
        try {
            val encPriv: PrivateKey = if (encJwk != null) {
                rsaKf.generatePrivate(
                    RSAPrivateCrtKeySpec(
                        big(encJwk.getString("n")), big(encJwk.getString("e")), big(encJwk.getString("d")),
                        big(encJwk.getString("p")), big(encJwk.getString("q")), big(encJwk.getString("dp")),
                        big(encJwk.getString("dq")), big(encJwk.getString("qi")),
                    ),
                )
            } else {
                rsaKf.generatePrivate(PKCS8EncodedKeySpec(o.getString("encPriv").unb64()))
            }
            val sigPriv: PrivateKey = if (sigJwk != null) {
                ecKf.generatePrivate(ECPrivateKeySpec(big(sigJwk.getString("d")), ecSpec()))
            } else {
                ecKf.generatePrivate(PKCS8EncodedKeySpec(o.getString("sigPriv").unb64()))
            }
            return Identity(o.optInt("bits", 0), encPub, sigPub, encPriv, sigPriv, json)
        } catch (e: CryptoError) {
            throw e
        } catch (e: Exception) {
            throw CryptoError("identity", "Schlüssel-Backup unvollständig oder beschädigt")
        }
    }

    private val rsaPubCache = HashMap<String, PublicKey>()
    private val sigPubCache = HashMap<String, PublicKey>()

    @Synchronized
    fun encPub(spkiB64: String): PublicKey =
        rsaPubCache.getOrPut(spkiB64) { KeyFactory.getInstance("RSA", bc).generatePublic(X509EncodedKeySpec(spkiB64.unb64())) }

    @Synchronized
    fun sigPub(spkiB64: String): PublicKey =
        sigPubCache.getOrPut(spkiB64) { KeyFactory.getInstance("EC", bc).generatePublic(X509EncodedKeySpec(spkiB64.unb64())) }

    private val oaep get() = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)

    private fun rsaWrap(spkiB64: String, raw: ByteArray): ByteArray {
        val c = Cipher.getInstance("RSA/ECB/OAEPPadding", bc)
        c.init(Cipher.ENCRYPT_MODE, encPub(spkiB64), oaep)
        return c.doFinal(raw)
    }

    private fun rsaUnwrap(priv: PrivateKey, data: ByteArray): ByteArray {
        // Schnell: native RSA-Rohoperation der Plattform + OAEP-Dekodierung hier (Bouncy Castle rechnet in reinem Java
        // und braucht bei 4096 Bit mehrere hundert Millisekunden pro Nachricht).
        try {
            val k = ((priv as java.security.interfaces.RSAKey).modulus.bitLength() + 7) / 8
            val c = Cipher.getInstance("RSA/ECB/NoPadding")
            c.init(Cipher.DECRYPT_MODE, priv)
            val raw = c.doFinal(data)
            val em = ByteArray(k)
            if (raw.size > k) throw IllegalStateException("rsa size")
            System.arraycopy(raw, 0, em, k - raw.size, raw.size)
            return oaepDecode(em)
        } catch (e: CryptoError) {
            throw e
        } catch (e: Exception) {
            val c = Cipher.getInstance("RSA/ECB/OAEPPadding", bc)
            c.init(Cipher.DECRYPT_MODE, priv, oaep)
            return c.doFinal(data)
        }
    }

    private fun mgf1(seed: ByteArray, len: Int): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        val out = ByteArray(len)
        var off = 0
        var ctr = 0
        while (off < len) {
            md.update(seed)
            md.update(byteArrayOf((ctr ushr 24).toByte(), (ctr ushr 16).toByte(), (ctr ushr 8).toByte(), ctr.toByte()))
            val h = md.digest()
            val n = minOf(h.size, len - off)
            System.arraycopy(h, 0, out, off, n)
            off += n; ctr++
        }
        return out
    }

    /** RSAES-OAEP-Dekodierung (SHA-256, MGF1-SHA-256, leeres Label) – RFC 8017 §7.1.2. */
    private fun oaepDecode(em: ByteArray): ByteArray {
        val h = 32
        val bad = CryptoError("decrypt", "Entschlüsselung fehlgeschlagen")
        if (em.size < 2 * h + 2 || em[0].toInt() != 0) throw bad
        val seed = em.copyOfRange(1, 1 + h)
        val db = em.copyOfRange(1 + h, em.size)
        val sm = mgf1(db, h)
        for (i in seed.indices) seed[i] = (seed[i].toInt() xor sm[i].toInt()).toByte()
        val dm = mgf1(seed, db.size)
        for (i in db.indices) db[i] = (db[i].toInt() xor dm[i].toInt()).toByte()
        val lHash = MessageDigest.getInstance("SHA-256").digest(ByteArray(0))
        var bits = 0
        for (i in 0 until h) bits = bits or (db[i].toInt() xor lHash[i].toInt())
        var i = h
        while (i < db.size && db[i].toInt() == 0) i++
        if (bits != 0 || i >= db.size || db[i].toInt() != 1) throw bad
        return db.copyOfRange(i + 1, db.size)
    }

    // ------------------------------------------------------------------ Signaturen (P1363 <-> DER)
    private fun derInt(v: ByteArray): ByteArray {
        val t = stripZeros(v)
        val pad = (t[0].toInt() and 0x80) != 0
        val out = ByteArray(2 + t.size + (if (pad) 1 else 0))
        out[0] = 0x02
        out[1] = (t.size + (if (pad) 1 else 0)).toByte()
        System.arraycopy(t, 0, out, 2 + (if (pad) 1 else 0), t.size)
        return out
    }

    fun p1363ToDer(sig: ByteArray): ByteArray {
        if (sig.size != 64) throw CryptoError("signature", "Signatur ungültig")
        val r = derInt(sig.copyOfRange(0, 32))
        val s = derInt(sig.copyOfRange(32, 64))
        val out = ByteArray(2 + r.size + s.size)
        out[0] = 0x30
        out[1] = (r.size + s.size).toByte()
        System.arraycopy(r, 0, out, 2, r.size)
        System.arraycopy(s, 0, out, 2 + r.size, s.size)
        return out
    }

    fun derToP1363(der: ByteArray): ByteArray {
        var p = 2
        if ((der[1].toInt() and 0x80) != 0) p = 2 + (der[1].toInt() and 0x7f)
        val rl = der[p + 1].toInt() and 0xff
        val r = der.copyOfRange(p + 2, p + 2 + rl)
        p = p + 2 + rl
        val sl = der[p + 1].toInt() and 0xff
        val s = der.copyOfRange(p + 2, p + 2 + sl)
        val out = ByteArray(64)
        for ((src, off) in listOf(r to 0, s to 32)) {
            val t = stripZeros(src)
            System.arraycopy(t, 0, out, off + 32 - t.size, t.size)
        }
        return out
    }

    // ------------------------------------------------------------------ AES-GCM
    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray, aad: ByteArray): Cipher {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        return c
    }

    fun aesGcmEncrypt(key: ByteArray, iv: ByteArray, aad: ByteArray, data: ByteArray): ByteArray =
        gcm(Cipher.ENCRYPT_MODE, key, iv, aad).doFinal(data)

    fun aesGcmDecrypt(key: ByteArray, iv: ByteArray, aad: ByteArray, data: ByteArray): ByteArray =
        gcm(Cipher.DECRYPT_MODE, key, iv, aad).doFinal(data)

    // ------------------------------------------------------------------ HKDF-SHA256 (RFC 5869, 32 Byte Ausgabe)
    fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key, "HmacSHA256"))
        return m.doFinal(data)
    }

    fun hkdf32(ikm: ByteArray, salt: ByteArray, info: String): ByteArray {
        val prk = hmac(salt, ikm)
        return hmac(prk, info.utf8() + byteArrayOf(1))
    }

    // ------------------------------------------------------------------ Wiederherstellungsschlüssel
    private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    class RecoveryKey(val bytes: ByteArray, val text: String)

    fun newRecoveryKey(): RecoveryKey {
        val bytes = randomBytes(30)
        var bits = 0
        var value = 0
        val sb = StringBuilder()
        for (b in bytes) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                sb.append(B32[(value ushr (bits - 5)) and 31])
                bits -= 5
            }
            value = value and ((1 shl bits) - 1)
        }
        return RecoveryKey(bytes, sb.chunked(4).joinToString("-"))
    }

    fun parseRecoveryKey(text: String): ByteArray {
        val clean = text.uppercase().replace(Regex("[^A-Z0-9]"), "").replace('0', 'O').replace('1', 'I').replace('8', 'B')
        if (clean.length != 48 || clean.any { it !in B32 }) {
            throw CryptoError("recovery_format", "Der Wiederherstellungsschlüssel hat 48 Zeichen (A–Z, 2–7).")
        }
        val out = ByteArray(30)
        var bits = 0
        var value = 0
        var i = 0
        for (ch in clean) {
            value = (value shl 5) or B32.indexOf(ch)
            bits += 5
            if (bits >= 8) {
                out[i++] = ((value ushr (bits - 8)) and 255).toByte()
                bits -= 8
                value = value and ((1 shl bits) - 1)
            }
        }
        return out
    }

    private val recoverySalt = "vela-recovery-v1".utf8()

    /** Wert, den der Server als Beweis für den Besitz des Wiederherstellungsschlüssels bekommt (Hex). */
    fun recoveryAuth(recoveryBytes: ByteArray): String = hkdf32(recoveryBytes, recoverySalt, "auth").hex()

    private fun backupAad(username: String) = "vela-key-backup-v1|${username.lowercase()}".utf8()

    /** Verschlüsseltes Schlüssel-Backup (JSON-String) + Auth-Wert. */
    fun makeBackup(identityJson: String, recoveryBytes: ByteArray, username: String): Pair<String, String> {
        val key = hkdf32(recoveryBytes, recoverySalt, "backup")
        val iv = randomBytes(12)
        val ct = aesGcmEncrypt(key, iv, backupAad(username), identityJson.utf8())
        val backup = JSONObject().put("v", 1).put("iv", iv.b64()).put("ct", ct.b64()).toString()
        return backup to recoveryAuth(recoveryBytes)
    }

    fun openBackup(backup: String, recoveryBytes: ByteArray, username: String): String {
        val key = hkdf32(recoveryBytes, recoverySalt, "backup")
        val b = JSONObject(backup)
        return try {
            String(aesGcmDecrypt(key, b.getString("iv").unb64(), backupAad(username), b.getString("ct").unb64()), Charsets.UTF_8)
        } catch (e: Exception) {
            throw CryptoError("recovery_wrong", "Wiederherstellungsschlüssel passt nicht zu diesem Konto.")
        }
    }

    // ------------------------------------------------------------------ Nachrichten
    class Recipient(val id: String, val encPubB64: String)

    private fun aadOf(id: String, from: String, to: String) = "vela-msg-v1|$id|$from|$to"

    fun sealMessage(
        id: String, from: String, to: String, payload: JSONObject,
        recipients: List<Recipient>, signKey: PrivateKey, kv: Int,
    ): String {
        val aes = randomBytes(32)
        val iv = randomBytes(12)
        val aad = aadOf(id, from, to)
        val ct = aesGcmEncrypt(aes, iv, aad.utf8(), payload.toString().utf8())
        val k = JSONObject()
        for (r in recipients) k.put(r.id, rsaWrap(r.encPubB64, aes).b64())
        aes.fill(0)
        val ivB = iv.b64()
        val ctB = ct.b64()
        val s = Signature.getInstance("SHA256withECDSA", bc)
        s.initSign(signKey)
        s.update("$aad|$ivB|$ctB".utf8())
        val sig = derToP1363(s.sign()).b64()
        return JSONObject().put("v", 1).put("iv", ivB).put("ct", ctB).put("k", k).put("sig", sig).put("kv", kv).toString()
    }

    class Opened(val payload: JSONObject, val kv: Int)

    fun openMessage(
        envelope: String, id: String, from: String, to: String, me: String,
        decKey: PrivateKey, verifyKey: PublicKey?,
    ): Opened {
        val env = JSONObject(envelope)
        val aad = aadOf(id, from, to)
        if (verifyKey == null) throw CryptoError("no_key", "Kein Signaturschlüssel des Absenders bekannt")
        val ok = try {
            val v = Signature.getInstance("SHA256withECDSA", bc)
            v.initVerify(verifyKey)
            v.update("$aad|${env.getString("iv")}|${env.getString("ct")}".utf8())
            v.verify(p1363ToDer(env.getString("sig").unb64()))
        } catch (e: Exception) {
            false
        }
        if (!ok) throw CryptoError("signature", "Signatur ungültig – Nachricht wurde verändert oder stammt nicht vom Absender")
        val wrapped = env.optJSONObject("k")?.optString(me, "").orEmpty()
        if (wrapped.isEmpty()) throw CryptoError("not_for_me", "Nachricht ist nicht für dieses Konto verschlüsselt")
        val raw = try {
            rsaUnwrap(decKey, wrapped.unb64())
        } catch (e: Exception) {
            throw CryptoError("decrypt", "Entschlüsselung fehlgeschlagen (anderer Schlüssel?)")
        }
        val pt = try {
            aesGcmDecrypt(raw, env.getString("iv").unb64(), aad.utf8(), env.getString("ct").unb64())
        } catch (e: Exception) {
            throw CryptoError("decrypt", "Nachricht beschädigt")
        } finally {
            raw.fill(0)
        }
        return Opened(JSONObject(String(pt, Charsets.UTF_8)), env.optInt("kv", 1))
    }

    fun envelopeKeyVersion(envelope: String): Int = try { JSONObject(envelope).optInt("kv", 1) } catch (e: Exception) { 1 }

    // ------------------------------------------------------------------ Dateien
    class FileKey(val key: String, val nonce: String, val chunk: Int)

    private fun chunkIv(prefix: ByteArray, i: Int): ByteArray {
        val iv = ByteArray(12)
        System.arraycopy(prefix, 0, iv, 0, 8)
        iv[8] = (i ushr 24).toByte(); iv[9] = (i ushr 16).toByte(); iv[10] = (i ushr 8).toByte(); iv[11] = i.toByte()
        return iv
    }

    private fun readFully(input: InputStream, buf: ByteArray): Int {
        var n = 0
        while (n < buf.size) {
            val r = input.read(buf, n, buf.size - n)
            if (r < 0) break
            n += r
        }
        return n
    }

    /**
     * Verschlüsselt [input] blockweise in die Datei [dst]. Um zu wissen, welcher Block der letzte ist,
     * wird immer ein Block vorausgelesen.
     */
    fun encryptFile(input: InputStream, dst: File, onProgress: ((Long) -> Unit)? = null): FileKey {
        val key = randomBytes(32)
        val prefix = randomBytes(8)
        dst.outputStream().buffered().use { out ->
            var cur = ByteArray(FILE_CHUNK)
            var curLen = readFully(input, cur)
            var next = ByteArray(FILE_CHUNK)
            var i = 0
            var total = 0L
            while (true) {
                val nextLen = if (curLen == FILE_CHUNK) readFully(input, next) else 0
                val last = nextLen == 0
                val ct = aesGcmEncrypt(key, chunkIv(prefix, i), "vela-file-v1|$i|${if (last) 1 else 0}".utf8(), cur.copyOf(curLen))
                out.write(ct)
                total += curLen
                onProgress?.invoke(total)
                if (last) break
                val tmp = cur; cur = next; next = tmp; curLen = nextLen; i++
            }
        }
        return FileKey(key.b64(), prefix.b64(), FILE_CHUNK)
    }

    /** Entschlüsselt die Cipher-Datei [src] in den Stream [out]. */
    fun decryptFile(src: File, fk: FileKey, out: OutputStream, onProgress: ((Float) -> Unit)? = null) {
        val key = fk.key.unb64()
        val prefix = fk.nonce.unb64()
        val encChunk = fk.chunk + 16
        val size = src.length()
        val n = maxOf(1L, (size + encChunk - 1) / encChunk).toInt()
        src.inputStream().buffered().use { input ->
            val buf = ByteArray(encChunk)
            for (i in 0 until n) {
                val len = readFully(input, buf)
                val last = if (i == n - 1) 1 else 0
                val pt = try {
                    aesGcmDecrypt(key, chunkIv(prefix, i), "vela-file-v1|$i|$last".utf8(), buf.copyOf(len))
                } catch (e: Exception) {
                    throw CryptoError("file_corrupt", "Datei beschädigt oder manipuliert")
                }
                out.write(pt)
                onProgress?.invoke((i + 1f) / n)
            }
        }
    }

    // ------------------------------------------------------------------ QR-Anmeldung (ECDH P-256 + HKDF + AES-GCM)
    class LinkPair(val priv: PrivateKey, val pubB64url: String)

    private fun rawPoint(pub: ECPublicKey): ByteArray {
        fun fixed(b: BigInteger): ByteArray {
            val raw = stripZeros(b.toByteArray()); val out = ByteArray(32)
            System.arraycopy(raw, 0, out, 32 - raw.size, raw.size); return out
        }
        return byteArrayOf(4) + fixed(pub.w.affineX) + fixed(pub.w.affineY)
    }

    fun newLinkPair(): LinkPair {
        val g = KeyPairGenerator.getInstance("EC", bc)
        g.initialize(ECGenParameterSpec("secp256r1"))
        val kp = g.generateKeyPair()
        return LinkPair(kp.private, rawPoint(kp.public as ECPublicKey).b64url())
    }

    private fun importRawPub(raw: ByteArray): PublicKey {
        if (raw.size != 65 || raw[0].toInt() != 4) throw CryptoError("link", "Ungültiger Schlüssel im QR-Code")
        val x = BigInteger(1, raw.copyOfRange(1, 33)); val y = BigInteger(1, raw.copyOfRange(33, 65))
        return KeyFactory.getInstance("EC", bc).generatePublic(java.security.spec.ECPublicKeySpec(java.security.spec.ECPoint(x, y), ecSpec()))
    }

    private fun linkKey(priv: PrivateKey, peerRaw: ByteArray, id: String): ByteArray {
        val ka = javax.crypto.KeyAgreement.getInstance("ECDH", bc)
        ka.init(priv)
        ka.doPhase(importRawPub(peerRaw), true)
        val salt = ByteArray(id.length / 2) { i -> id.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
        return hkdf32(ka.generateSecret(), salt, "vela-link-v1")
    }

    private fun linkAad(id: String) = "vela-link|$id".utf8()

    class LinkApproval(val phonePub: String, val iv: String, val ct: String)

    /** Handy bestätigt: verschlüsselt das Schlüsselpaket für den Rechner, der den QR-Code zeigt. */
    fun linkApprove(id: String, deskPubB64url: String, bundleJson: String): LinkApproval {
        val g = KeyPairGenerator.getInstance("EC", bc)
        g.initialize(ECGenParameterSpec("secp256r1"))
        val kp = g.generateKeyPair()
        val key = linkKey(kp.private, deskPubB64url.unb64url(), id)
        val iv = randomBytes(12)
        val ct = aesGcmEncrypt(key, iv, linkAad(id), bundleJson.utf8())
        return LinkApproval(rawPoint(kp.public as ECPublicKey).b64url(), iv.b64url(), ct.b64url())
    }

    /** Rechner holt ab: entschlüsselt das Paket mit seinem privaten Schlüssel. */
    fun linkClaim(pair: LinkPair, id: String, phonePubB64url: String, ivB64url: String, ctB64url: String): String {
        val key = linkKey(pair.priv, phonePubB64url.unb64url(), id)
        return try {
            String(aesGcmDecrypt(key, ivB64url.unb64url(), linkAad(id), ctB64url.unb64url()), Charsets.UTF_8)
        } catch (e: Exception) {
            throw CryptoError("link", "Das Schlüsselpaket konnte nicht entschlüsselt werden")
        }
    }

    private val linkRe = Regex("^vela-link:1:([a-f0-9]{32}):([A-Za-z0-9_-]{87})$")

    /** Liest „vela-link:1:<id>:<pub>“. */
    fun parseLink(text: String): Pair<String, String>? = linkRe.find(text.trim())?.let { it.groupValues[1] to it.groupValues[2] }

    // ------------------------------------------------------------------ Fingerabdrücke / Sicherheitsnummer
    private fun fingerprint(encPub: String, sigPub: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(encPub.unb64() + sigPub.unb64())

    private fun fpDigits(fp: ByteArray): List<String> = (0 until 6).map { i ->
        var v = 0L
        for (j in 0 until 5) v = v * 256 + (fp[i * 5 + j].toInt() and 0xff)
        (v % 100000).toString().padStart(5, '0')
    }

    class KeyInfo(val id: String, val encPub: String, val sigPub: String)

    fun safetyNumber(a: KeyInfo, b: KeyInfo): List<String> {
        val (x, y) = listOf(a, b).sortedBy { it.id }
        return fpDigits(fingerprint(x.encPub, x.sigPub)) + fpDigits(fingerprint(y.encPub, y.sigPub))
    }

    fun shortFingerprint(encPub: String, sigPub: String): String =
        fingerprint(encPub, sigPub).copyOf(16).hex().uppercase().chunked(4).joinToString(" ")

}
