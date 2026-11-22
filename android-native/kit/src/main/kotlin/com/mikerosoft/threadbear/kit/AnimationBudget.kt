package com.mikerosoft.threadbear.kit

/**
 * How much a moving picture may make the phone decode (the iPhone's
 * AnimationPlan). Android's AnimatedImageDrawable decodes a frame at a time
 * at the size it's shown, but plays every frame there is: a small GIF of
 * thousands of frames under the byte and size caps kept the phone decoding
 * for as long as its row was on screen (Daybreak 166, 22 Nov 2026). So the
 * frames are counted from the file before anything plays, and one with too
 * many, or too many pixels across them all, shows its first frame still.
 */
object AnimationLimits {
    const val MAX_FRAMES = 600
    /** Pixels decoded for one pass through every frame at the shown size. */
    const val MAX_TOTAL_PIXELS = 400_000_000L
    /** Moving pictures playing at once, and their pixels per pass together. More stay still. */
    const val MAX_PLAYING = 4
    const val MAX_PLAYING_PIXELS = 800_000_000L
}

object AnimationFrames {
    /**
     * How many frames `data` has, for the formats Android plays (GIF, WebP,
     * APNG), counted from the file's own structure and stopping once past
     * `stopAfter`. Null for anything it can't count, which then stays still:
     * a moving picture is played only when its frames are known.
     */
    fun count(data: ByteArray, stopAfter: Int = AnimationLimits.MAX_FRAMES): Int? = when {
        startsWith(data, "GIF87a") || startsWith(data, "GIF89a") -> gif(data, stopAfter)
        startsWith(data, "RIFF") && data.size >= 12 && ascii(data, 8, 4) == "WEBP" -> webp(data, stopAfter)
        data.size >= 8 && PNG.indices.all { data[it] == PNG[it] } -> png(data, stopAfter)
        else -> null
    }

    /**
     * Pixels decoded for one pass at `shownWidth` by `shownHeight`, or null
     * when it mustn't play: frames uncounted, one or none, or over the limits.
     */
    fun passPixels(
        data: ByteArray,
        shownWidth: Int,
        shownHeight: Int,
        maxFrames: Int = AnimationLimits.MAX_FRAMES,
        maxTotalPixels: Long = AnimationLimits.MAX_TOTAL_PIXELS,
    ): Long? {
        if (shownWidth <= 0 || shownHeight <= 0) return null
        val frames = count(data, maxFrames) ?: return null
        if (frames < 2 || frames > maxFrames) return null
        val pixels = shownWidth.toLong() * shownHeight * frames
        return pixels.takeIf { it <= maxTotalPixels }
    }

    private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    private fun startsWith(data: ByteArray, text: String) = data.size >= text.length && ascii(data, 0, text.length) == text

    private fun ascii(data: ByteArray, at: Int, n: Int) = String(data, at, n, Charsets.ISO_8859_1)

    private fun u8(data: ByteArray, at: Int) = data[at].toInt() and 0xFF

    private fun le32(data: ByteArray, at: Int): Long =
        (u8(data, at).toLong()) or (u8(data, at + 1).toLong() shl 8) or (u8(data, at + 2).toLong() shl 16) or (u8(data, at + 3).toLong() shl 24)

    private fun be32(data: ByteArray, at: Int): Long =
        (u8(data, at).toLong() shl 24) or (u8(data, at + 1).toLong() shl 16) or (u8(data, at + 2).toLong() shl 8) or u8(data, at + 3).toLong()

    /**
     * Image descriptors, walking the blocks. A file cut short counts what's
     * there (the decoder stops there too); a block that isn't GIF's says
     * nothing can be trusted, so null.
     */
    private fun gif(data: ByteArray, stopAfter: Int): Int? {
        if (data.size < 13) return null
        var at = 13
        val flags = u8(data, 10)
        if (flags and 0x80 != 0) at += 3 * (1 shl ((flags and 0x07) + 1))
        var frames = 0
        fun skipSubBlocks(): Boolean {
            while (true) {
                if (at >= data.size) return false
                val n = u8(data, at)
                at += 1
                if (n == 0) return true
                at += n
            }
        }
        while (at < data.size) {
            when (u8(data, at)) {
                0x2C -> {
                    frames++
                    if (frames > stopAfter) return frames
                    if (at + 10 > data.size) return frames
                    val local = u8(data, at + 9)
                    at += 10
                    if (local and 0x80 != 0) at += 3 * (1 shl ((local and 0x07) + 1))
                    // The LZW code size, then the image's data.
                    at += 1
                    if (!skipSubBlocks()) return frames
                }
                0x21 -> {
                    at += 2
                    if (!skipSubBlocks()) return frames
                }
                0x3B -> return frames
                else -> return null
            }
        }
        return frames
    }

    /** ANMF chunks; a still WebP (no animation) is one frame. */
    private fun webp(data: ByteArray, stopAfter: Int): Int? {
        var at = 12
        var frames = 0
        var image = false
        while (at + 8 <= data.size) {
            val type = ascii(data, at, 4)
            val size = le32(data, at + 4)
            when (type) {
                "ANMF" -> {
                    frames++
                    if (frames > stopAfter) return frames
                }
                "VP8 ", "VP8L" -> image = true
            }
            val next = at + 8 + size + (size and 1)
            if (next > data.size) break
            at = next.toInt()
        }
        return if (frames > 0) frames else if (image) 1 else null
    }

    /**
     * APNG's frames: the larger of what acTL says and the fcTL chunks there
     * are, so neither can understate it. A plain PNG is one.
     */
    private fun png(data: ByteArray, stopAfter: Int): Int? {
        var at = 8
        var declared = 0L
        var controls = 0
        while (at + 8 <= data.size) {
            val size = be32(data, at)
            val type = ascii(data, at + 4, 4)
            when (type) {
                "acTL" -> if (at + 12 <= data.size) declared = be32(data, at + 8)
                "fcTL" -> {
                    controls++
                    if (controls > stopAfter) return controls
                }
                "IEND" -> break
            }
            val next = at + 12 + size
            if (next > data.size) break
            at = next.toInt()
        }
        val frames = maxOf(declared, controls.toLong(), 1L)
        return if (frames > stopAfter) stopAfter + 1 else frames.toInt()
    }
}

/**
 * The moving pictures playing now, held to AnimationLimits' MAX_PLAYING
 * and MAX_PLAYING_PIXELS together: however many are on screen, the phone
 * decodes no more than that. One that doesn't get a place shows its first
 * frame until it's shown again.
 */
class PlaybackBudget(
    private val maxPlaying: Int = AnimationLimits.MAX_PLAYING,
    private val maxPixels: Long = AnimationLimits.MAX_PLAYING_PIXELS,
) {
    private var playing = 0
    private var pixels = 0L

    /** A place for one of `passPixels`, or false when there's no room. Give it back with [give]. */
    @Synchronized
    fun take(passPixels: Long): Boolean {
        if (passPixels <= 0 || playing >= maxPlaying || pixels + passPixels > maxPixels) return false
        playing++
        pixels += passPixels
        return true
    }

    @Synchronized
    fun give(passPixels: Long) {
        playing = (playing - 1).coerceAtLeast(0)
        pixels = (pixels - passPixels).coerceAtLeast(0)
    }

    val playingNow: Int @Synchronized get() = playing
}
