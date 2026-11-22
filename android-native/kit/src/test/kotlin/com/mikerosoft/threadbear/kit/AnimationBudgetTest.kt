package com.mikerosoft.threadbear.kit

import java.io.ByteArrayOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Daybreak 166 (22 Nov 2026): a small moving picture of thousands of frames
 * passed every byte and size cap and played every frame. Its frames are now
 * counted from the file first, as the iPhone's AnimationPlan does.
 */
class AnimationBudgetTest {
    @Test fun gifFramesAreCounted() {
        assertEquals(1, AnimationFrames.count(gif(1)))
        assertEquals(12, AnimationFrames.count(gif(12)))
        assertEquals(12, AnimationFrames.count(gif(12, colorTables = true)), "colour tables skipped right")
        // Counting stops once it's past the limit, however many there are.
        assertEquals(AnimationLimits.MAX_FRAMES + 1, AnimationFrames.count(gif(5_000)))
    }

    @Test fun framesJustUnderAndOverTheLimits() {
        val (w, h) = 10 to 10
        assertNotNull(AnimationFrames.passPixels(gif(AnimationLimits.MAX_FRAMES), w, h), "600 frames play")
        assertNull(AnimationFrames.passPixels(gif(AnimationLimits.MAX_FRAMES + 1), w, h), "601 stay still")
        // Pixels across every frame at the shown size: 100 frames of 2000x2000 is 400 million.
        assertNotNull(AnimationFrames.passPixels(gif(100), 2000, 2000))
        assertNull(AnimationFrames.passPixels(gif(101), 2000, 2000))
        assertNull(AnimationFrames.passPixels(gif(1), w, h), "one frame is a still")
    }

    @Test fun everyMovingFormatHasTheSameBudget() {
        for ((name, make) in listOf<Pair<String, (Int) -> ByteArray>>("gif" to { gif(it) }, "webp" to ::webp, "apng" to { apng(it) })) {
            assertEquals(7, AnimationFrames.count(make(7)), name)
            assertNotNull(AnimationFrames.passPixels(make(AnimationLimits.MAX_FRAMES), 10, 10), name)
            assertNull(AnimationFrames.passPixels(make(AnimationLimits.MAX_FRAMES + 1), 10, 10), name)
        }
        // APNG: whichever of acTL and the fcTL chunks says more.
        assertNull(AnimationFrames.passPixels(apng(3, declared = 100_000), 10, 10))
        assertNull(AnimationFrames.passPixels(apng(AnimationLimits.MAX_FRAMES + 1, declared = 2), 10, 10))
    }

    @Test fun whatCantBeCountedStaysStill() {
        assertNull(AnimationFrames.count(byteArrayOf(1, 2, 3)))
        assertNull(AnimationFrames.passPixels("GIF89a".toByteArray() + ByteArray(7) + byteArrayOf(0x55), 10, 10), "a block GIF doesn't have")
        assertNull(AnimationFrames.passPixels(ByteArray(64), 10, 10))
    }

    @Test fun aGifCutShortCountsWhatsThere() {
        val whole = gif(10)
        assertTrue(AnimationFrames.count(whole.copyOf(whole.size / 2))!! in 1..10)
    }

    @Test fun onlyAFewPlayAtOnce() {
        val budget = PlaybackBudget(maxPlaying = 4, maxPixels = 1_000)
        repeat(4) { assertTrue(budget.take(100)) }
        assertFalse(budget.take(100), "a fifth stays still")
        budget.give(100)
        assertTrue(budget.take(100), "until one stops")
        assertEquals(4, budget.playingNow)
        val pixels = PlaybackBudget(maxPlaying = 10, maxPixels = 1_000)
        assertTrue(pixels.take(600))
        assertFalse(pixels.take(500), "over the pixels together")
        assertTrue(pixels.take(400))
        assertFalse(PlaybackBudget().take(0), "nothing counted, nothing played")
    }

    @Test fun manyVisibleAnimationsStayWithinTheTotal() {
        val budget = PlaybackBudget()
        val each = AnimationLimits.MAX_TOTAL_PIXELS
        val playing = (0 until 50).count { budget.take(each) }
        assertTrue(playing * each <= AnimationLimits.MAX_PLAYING_PIXELS)
        assertTrue(playing <= AnimationLimits.MAX_PLAYING)
        assertTrue(playing >= 1)
    }

    // ---- files, made by hand: a frame each, a byte of picture in it.

    private fun gif(frames: Int, colorTables: Boolean = false): ByteArray {
        val out = ByteArrayOutputStream()
        out.write("GIF89a".toByteArray())
        // 1x1, global colour table of 2 entries when asked.
        out.write(byteArrayOf(1, 0, 1, 0, if (colorTables) 0x80.toByte() else 0, 0, 0))
        if (colorTables) out.write(ByteArray(6))
        // Netscape loop extension.
        out.write(byteArrayOf(0x21, 0xFF.toByte(), 11) + "NETSCAPE2.0".toByteArray() + byteArrayOf(3, 1, 0, 0, 0))
        repeat(frames) {
            out.write(byteArrayOf(0x21, 0xF9.toByte(), 4, 0, 1, 0, 0, 0))
            out.write(byteArrayOf(0x2C, 0, 0, 0, 0, 1, 0, 1, 0, if (colorTables) 0x80.toByte() else 0))
            if (colorTables) out.write(ByteArray(6))
            out.write(byteArrayOf(2, 2, 0x44, 0x01, 0))
        }
        out.write(0x3B)
        return out.toByteArray()
    }

    private fun le(n: Int) = byteArrayOf(n.toByte(), (n shr 8).toByte(), (n shr 16).toByte(), (n shr 24).toByte())
    private fun be(n: Int) = byteArrayOf((n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())

    private fun webp(frames: Int): ByteArray {
        val body = ByteArrayOutputStream()
        body.write("WEBP".toByteArray())
        body.write("VP8X".toByteArray() + le(10) + ByteArray(10))
        body.write("ANIM".toByteArray() + le(6) + ByteArray(6))
        repeat(frames) { body.write("ANMF".toByteArray() + le(17) + ByteArray(17) + byteArrayOf(0)) }
        val b = body.toByteArray()
        return "RIFF".toByteArray() + le(b.size) + b
    }

    private fun apng(frames: Int, declared: Int = frames): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        fun chunk(type: String, data: ByteArray) = out.write(be(data.size) + type.toByteArray() + data + ByteArray(4))
        chunk("IHDR", ByteArray(13))
        chunk("acTL", be(declared) + be(0))
        repeat(frames) { chunk("fcTL", ByteArray(26)); chunk(if (it == 0) "IDAT" else "fdAT", ByteArray(4)) }
        chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }
}
