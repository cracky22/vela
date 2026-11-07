package de.cracky.vela.core

import java.security.SecureRandom
import java.util.Base64

private val rng = SecureRandom()

fun ByteArray.b64(): String = Base64.getEncoder().encodeToString(this)
fun String.unb64(): ByteArray = Base64.getDecoder().decode(this)
fun ByteArray.b64url(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(this)
fun String.unb64url(): ByteArray = Base64.getUrlDecoder().decode(this)
fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }
fun String.utf8(): ByteArray = toByteArray(Charsets.UTF_8)

fun randomBytes(n: Int): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

/** 32 Hex-Zeichen, wie `randomId()` im Web-Client. */
fun randomId(): String = randomBytes(16).hex()

class CryptoError(val code: String, message: String) : Exception(message)
