package com.mikerosoft.threadbear.kit

/**
 * How much a moving picture may make the phone decode (the iPhone's
 * AnimationPlan, and more). Android's AnimatedImageDrawable plays every
 * frame there is, decoding each from the file's own size before scaling it
 * down: a small GIF of thousands of frames under the byte and size caps
 * kept the phone decoding for as long as its row was on screen (Daybreak
 * 166, 22 Nov 2026). So the frames and their times are read from the file
 * before anything plays, and one with too many frames, too many pixels
 * across them, or too many a second shows its first frame still.
 */
object AnimationLimits {
    const val MAX_FRAMES = 600
    /** Pixels decoded for one pass through every frame, at the file's own size (or the shown size, if bigger). */
    const val MAX_TOTAL_PIXELS = 400_000_000L
    /** Pixels decoded a second while it plays: about a 1400-pixel-square picture at 60 frames a second. */
    const val MAX_PIXELS_PER_SECOND = 120_000_000L
    /** A frame's shortest time: one a picture says is shorter still is counted as this long, as it may play that fast. */
    const val MIN_FRAME_MS = 10L
    /** Moving pictures playing at once, and their pixels a second together. More stay still. */
    const val MAX_PLAYING = 4
    const val MAX_PLAYING_PIXELS_PER_SECOND = 240_000_000L
}

/** What playing a moving picture costs: pixels decoded for one pass through its frames, and a second. */
data class AnimationWork(val passPixels: Long, val pixelsPerSecond: Long)

object AnimationFrames {
    /** Frames, and one pass through them in milliseconds (each at least MIN_FRAME_MS). */
    data class Frames(val count: Int, val loopMs: Long)

    /**
     * How many frames `data` has, for the formats Android plays (GIF, WebP,
     * APNG), counted from the file's own structure and stopping once past
     * `stopAfter`. Null for anything it can't count, which then stays still.
     */
    fun count(data: ByteArray, stopAfter: Int = AnimationLimits.MAX_FRAMES): Int? = scan(data, stopAfter)?.count

    fun scan(data: ByteArray, stopAfter: Int = AnimationLimits.MAX_FRAMES): Frames? = when {
        startsWith(data, "GIF87a") || startsWith(data, "GIF89a") -> gif(data, stopAfter)
        startsWith(data, "RIFF") && data.size >= 12 && ascii(data, 8, 4) == "WEBP" -> webp(data, stopAfter)
        data.size >= 8 && PNG.indices.all { data[it] == PNG[it] } -> png(data, stopAfter)
        else -> null
    }

    /**
     * What playing `data` costs, its frames decoded at `sourceWidth` by
     * `sourceHeight` (the decoder reads each whole before scaling) and shown
     * at `shownWidth` by `shownHeight`; or null when it mustn't play: frames
     * uncounted, one or none, or over any of AnimationLimits.
     */
    fun work(
        data: ByteArray,
        sourceWidth: Int,
        sourceHeight: Int,
        shownWidth: Int,
        shownHeight: Int,
        maxFrames: Int = AnimationLimits.MAX_FRAMES,
        maxTotalPixels: Long = AnimationLimits.MAX_TOTAL_PIXELS,
        maxPixelsPerSecond: Long = AnimationLimits.MAX_PIXELS_PER_SECOND,
    ): AnimationWork? {
        if (sourceWidth <= 0 || sourceHeight <= 0 || shownWidth <= 0 || shownHeight <= 0) return null
        val frames = scan(data, maxFrames) ?: return null
        if (frames.count < 2 || frames.count > maxFrames) return null
        // Both sides are under 2^31, so neither product overflows a Long.
        val frame = maxOf(sourceWidth.toLong() * sourceHeight, shownWidth.toLong() * shownHeight)
        if (frame > maxTotalPixels / frames.count) return null
        val pass = frame * frames.count
        val perSecond = pass * 1000 / frames.loopMs.coerceAtLeast(1)
        if (perSecond > maxPixelsPerSecond) return null
        return AnimationWork(pass, perSecond)
    }

    private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    private fun startsWith(data: ByteArray, text: String) = data.size >= text.length && ascii(data, 0, text.length) == text

    private fun ascii(data: ByteArray, at: Int, n: Int) = String(data, at, n, Charsets.ISO_8859_1)

    private fun u8(data: ByteArray, at: Int) = data[at].toInt() and 0xFF

    private fun le16(data: ByteArray, at: Int) = u8(data, at) or (u8(data, at + 1) shl 8)

    private fun be16(data: ByteArray, at: Int) = (u8(data, at) shl 8) or u8(data, at + 1)

    private fun le24(data: ByteArray, at: Int) = u8(data, at) or (u8(data, at + 1) shl 8) or (u8(data, at + 2) shl 16)

    private fun le32(data: ByteArray, at: Int): Long = le24(data, at).toLong() or (u8(data, at + 3).toLong() shl 24)

    private fun be32(data: ByteArray, at: Int): Long = (be16(data, at).toLong() shl 16) or be16(data, at + 2).toLong()

    private fun frameMs(ms: Long) = ms.coerceAtLeast(AnimationLimits.MIN_FRAME_MS)

    /**
     * Image descriptors, walking the blocks, each frame's time from the
     * graphic control block before it. A file cut short counts what's
     * there (the decoder stops there too). A block that isn't GIF's, or a
     * graphic control block that isn't its fixed four bytes (Skia reads four
     * whatever it says, and goes on past where this would stop: Codex's
     * review), says the count can't be trusted, so null. Zero bytes between
     * blocks are padding some encoders write, skipped as decoders skip them.
     */
    private fun gif(data: ByteArray, stopAfter: Int): Frames? {
        if (data.size < 13) return null
        var at = 13
        val flags = u8(data, 10)
        if (flags and 0x80 != 0) at += 3 * (1 shl ((flags and 0x07) + 1))
        var frames = 0
        var loopMs = 0L
        var delayMs = 0L
        fun skipSubBlocks(): Boolean {
            while (true) {
                if (at >= data.size) return false
                val n = u8(data, at)
                at += 1
                if (n == 0) return true
                at += n
            }
        }
        fun done() = Frames(frames, loopMs)
        while (at < data.size) {
            when (u8(data, at)) {
                0x2C -> {
                    frames++
                    loopMs += frameMs(delayMs)
                    delayMs = 0
                    if (frames > stopAfter) return done()
                    if (at + 10 > data.size) return done()
                    val local = u8(data, at + 9)
                    at += 10
                    if (local and 0x80 != 0) at += 3 * (1 shl ((local and 0x07) + 1))
                    // The LZW code size, then the image's data.
                    at += 1
                    if (!skipSubBlocks()) return done()
                }
                0x21 -> {
                    if (at + 1 >= data.size) return done()
                    if (u8(data, at + 1) == 0xF9) {
                        if (at + 2 >= data.size) return done()
                        if (u8(data, at + 2) != 4) return null
                        if (at + 8 > data.size) return done()
                        delayMs = le16(data, at + 4) * 10L
                        if (u8(data, at + 7) != 0) return null
                        at += 8
                    } else {
                        at += 2
                        if (!skipSubBlocks()) return done()
                    }
                }
                0x00 -> at += 1
                0x3B -> return done()
                else -> return null
            }
        }
        return done()
    }

    /** ANMF chunks and their durations; a still WebP (no animation) is one frame. */
    private fun webp(data: ByteArray, stopAfter: Int): Frames? {
        var at = 12
        var frames = 0
        var loopMs = 0L
        var image = false
        while (at + 8 <= data.size) {
            val type = ascii(data, at, 4)
            val size = le32(data, at + 4)
            when (type) {
                "ANMF" -> {
                    frames++
                    val duration = if (size >= 16 && at + 8 + 15 <= data.size) le24(data, at + 8 + 12).toLong() else 0L
                    loopMs += frameMs(duration)
                    if (frames > stopAfter) return Frames(frames, loopMs)
                }
                "VP8 ", "VP8L" -> image = true
            }
            val next = at + 8 + size + (size and 1)
            if (next > data.size) break
            at = next.toInt()
        }
        return if (frames > 0) Frames(frames, loopMs) else if (image) Frames(1, frameMs(0)) else null
    }

    /**
     * APNG's frames: the larger of what any acTL says and the fcTL chunks
     * there are, so neither can understate it; frames with no fcTL of their
     * own are counted at the shortest time. A plain PNG is one.
     */
    private fun png(data: ByteArray, stopAfter: Int): Frames? {
        var at = 8
        var declared = 0L
        var controls = 0
        var loopMs = 0L
        while (at + 8 <= data.size) {
            val size = be32(data, at)
            val type = ascii(data, at + 4, 4)
            when (type) {
                "acTL" -> if (size >= 8 && at + 12 <= data.size) declared = maxOf(declared, be32(data, at + 8))
                "fcTL" -> {
                    controls++
                    if (size >= 26 && at + 8 + 24 <= data.size) {
                        val num = be16(data, at + 8 + 20).toLong()
                        val den = be16(data, at + 8 + 22).toLong().takeIf { it > 0 } ?: 100L
                        loopMs += frameMs(num * 1000 / den)
                    } else {
                        loopMs += frameMs(0)
                    }
                    if (controls > stopAfter) return Frames(controls, loopMs)
                }
                "IEND" -> break
            }
            val next = at + 12 + size
            if (next > data.size) break
            at = next.toInt()
        }
        val frames = maxOf(declared, controls.toLong(), 1L)
        if (frames > stopAfter) return Frames(stopAfter + 1, loopMs)
        loopMs += (frames - controls) * frameMs(0)
        return Frames(frames.toInt(), loopMs)
    }
}

/**
 * The moving pictures playing now, held to AnimationLimits' MAX_PLAYING
 * and MAX_PLAYING_PIXELS_PER_SECOND together: however many are on screen,
 * the phone decodes no more than that. One that doesn't get a place shows
 * its first frame until it's shown again.
 */
class PlaybackBudget(
    private val maxPlaying: Int = AnimationLimits.MAX_PLAYING,
    private val maxPixelsPerSecond: Long = AnimationLimits.MAX_PLAYING_PIXELS_PER_SECOND,
) {
    private var playing = 0
    private var rate = 0L

    /** A place for one decoding `pixelsPerSecond`, or false when there's no room. Give it back with [give]. */
    @Synchronized
    fun take(pixelsPerSecond: Long): Boolean {
        if (pixelsPerSecond <= 0 || playing >= maxPlaying || rate + pixelsPerSecond > maxPixelsPerSecond) return false
        playing++
        rate += pixelsPerSecond
        return true
    }

    @Synchronized
    fun give(pixelsPerSecond: Long) {
        playing = (playing - 1).coerceAtLeast(0)
        rate = (rate - pixelsPerSecond).coerceAtLeast(0)
    }

    val playingNow: Int @Synchronized get() = playing
}
