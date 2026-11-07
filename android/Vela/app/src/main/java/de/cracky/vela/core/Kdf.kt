package de.cracky.vela.core

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.json.JSONObject
import java.text.Normalizer

/**
 * Schlüsseltresor (Passwort -> Argon2id -> HKDF -> { auth, wrap }), kompatibel zu static/js/vault.js.
 */
object Kdf {
    private val salt = "vela-vault-v1".utf8()

    class Params(val salt: String, val t: Int, val m: Int, val p: Int)

    fun parse(o: JSONObject) = Params(o.getString("salt"), o.getInt("t"), o.getInt("m"), o.getInt("p"))

    fun toJson(p: Params): JSONObject =
        JSONObject().put("alg", "argon2id").put("salt", p.salt).put("t", p.t).put("m", p.m).put("p", p.p)

    fun newParams() = Params(randomBytes(16).b64(), 3, 65536, 1)

    class Derived(val authHex: String, val wrap: ByteArray)

    fun derive(password: String, k: Params): Derived {
        val pw = Normalizer.normalize(password, Normalizer.Form.NFKC).utf8()
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withIterations(k.t).withMemoryAsKB(k.m).withParallelism(k.p)
            .withSalt(k.salt.unb64()).build()
        val gen = Argon2BytesGenerator()
        gen.init(params)
        val raw = ByteArray(32)
        gen.generateBytes(pw, raw)
        val auth = Crypto.hkdf32(raw, salt, "auth").hex()
        val wrap = Crypto.hkdf32(raw, salt, "wrap")
        raw.fill(0)
        return Derived(auth, wrap)
    }

    private fun aad(username: String) = "vela-vault-v1|${username.lowercase()}".utf8()

    fun seal(identityJson: String, wrap: ByteArray, username: String): String {
        val iv = randomBytes(12)
        val ct = Crypto.aesGcmEncrypt(wrap, iv, aad(username), identityJson.utf8())
        return JSONObject().put("v", 1).put("iv", iv.b64()).put("ct", ct.b64()).toString()
    }

    fun open(blob: String, wrap: ByteArray, username: String): String {
        val o = JSONObject(blob)
        return try {
            String(Crypto.aesGcmDecrypt(wrap, o.getString("iv").unb64(), aad(username), o.getString("ct").unb64()), Charsets.UTF_8)
        } catch (e: Exception) {
            throw CryptoError("vault", "Passwort falsch oder Tresor beschädigt")
        }
    }
}
