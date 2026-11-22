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

    /** Pixels for a frame of w by h, shown at the same size. */
    private fun work(data: ByteArray, w: Int, h: Int) = AnimationFrames.work(data, w, h, w, h)

    @Test fun framesJustUnderAndOverTheLimits() {
        // 100 ms frames (the files below), 10x10.
        assertNotNull(work(gif(AnimationLimits.MAX_FRAMES), 10, 10), "600 frames play")
        assertNull(work(gif(AnimationLimits.MAX_FRAMES + 1), 10, 10), "601 stay still")
        // Pixels across every frame: 100 frames of 2000x2000 is 400 million.
        assertNotNull(AnimationFrames.work(gif(100, delayCs = 100), 2000, 2000, 2000, 2000))
        assertNull(AnimationFrames.work(gif(101, delayCs = 100), 2000, 2000, 2000, 2000))
        assertNull(work(gif(1), 10, 10), "one frame is a still")
    }

    /** Gemini's review: the decoder reads every frame at the file's own size, whatever it's shown at. */
    @Test fun framesCountAtTheFilesOwnSize() {
        val wide = gif(600, delayCs = 100)
        // 50,000 x 1,000 shown 1400 x 28: the source's pixels count.
        assertNull(AnimationFrames.work(wide, 50_000, 1_000, 1400, 28))
        assertNotNull(AnimationFrames.work(wide, 500, 10, 1400, 28), "and the shown size, when it's the bigger")
        assertNull(AnimationFrames.work(gif(2), Int.MAX_VALUE, Int.MAX_VALUE, 10, 10), "no overflow")
    }

    /** Codex's and Gemini's reviews: a pass within budget can still loop fast enough to keep the phone busy. */
    @Test fun pixelsASecondAreBounded() {
        // 2000x2000, 10 frames: 40 million a pass.
        assertNotNull(AnimationFrames.work(gif(10, delayCs = 10), 2000, 2000, 2000, 2000), "10 a second: 40 million a second")
        assertNull(AnimationFrames.work(gif(10, delayCs = 2), 2000, 2000, 2000, 2000), "50 a second: 200 million")
        // A frame time of 0 counts as the shortest a frame can play.
        assertNull(AnimationFrames.work(gif(10, delayCs = 0), 2000, 2000, 2000, 2000))
        assertNotNull(AnimationFrames.work(gif(10, delayCs = 0), 100, 100, 100, 100), "small ones still play")
        assertEquals(1000L, AnimationFrames.scan(gif(10, delayCs = 10))!!.loopMs)
    }

    @Test fun everyMovingFormatHasTheSameBudget() {
        for ((name, make) in listOf<Pair<String, (Int) -> ByteArray>>("gif" to { gif(it) }, "webp" to { webp(it) }, "apng" to { apng(it) })) {
            assertEquals(7, AnimationFrames.count(make(7)), name)
            assertEquals(700L, AnimationFrames.scan(make(7))!!.loopMs, "$name: 100 ms a frame")
            assertNotNull(work(make(AnimationLimits.MAX_FRAMES), 10, 10), name)
            assertNull(work(make(AnimationLimits.MAX_FRAMES + 1), 10, 10), name)
        }
        // APNG: whichever of acTL (any of them) and the fcTL chunks says more.
        assertNull(work(apng(3, declared = 100_000), 10, 10))
        assertNull(work(apng(AnimationLimits.MAX_FRAMES + 1, declared = 2), 10, 10))
        assertNull(work(apng(3, declared = 100_000, secondDeclared = 2), 10, 10), "a second acTL can't lower it")
    }

    @Test fun whatCantBeCountedStaysStill() {
        assertNull(AnimationFrames.count(byteArrayOf(1, 2, 3)))
        assertNull(work("GIF89a".toByteArray() + ByteArray(7) + byteArrayOf(0x55), 10, 10), "a block GIF doesn't have")
        assertNull(work(ByteArray(64), 10, 10))
    }

    /** Codex's review: a graphic control block that says it's shorter than four bytes, which Skia reads past. */
    @Test fun aMalformedGraphicControlBlockStaysStill() {
        val head = gif(2)
        val body = head.copyOf(head.size - 1) + byteArrayOf(0x21, 0xF9.toByte(), 0x00, 0x3B, 0x02, 0, 0, 0) + gif(3000).drop(13 + 19).toByteArray()
        assertNull(AnimationFrames.count(body))
    }

    /** Gemini's review: zero bytes between blocks are padding, not the end. */
    @Test fun paddingBetweenBlocksIsSkipped() {
        val g = gif(3)
        val padded = g.copyOf(g.size - 1) + byteArrayOf(0, 0) + g.copyOfRange(13 + 19, g.size)
        assertEquals(6, AnimationFrames.count(padded))
    }

    @Test fun aGifCutShortCountsWhatsThere() {
        val whole = gif(10)
        assertTrue(AnimationFrames.count(whole.copyOf(whole.size / 2))!! in 1..10)
    }

    @Test fun onlyAFewPlayAtOnce() {
        val budget = PlaybackBudget(maxPlaying = 4, maxPixelsPerSecond = 1_000)
        repeat(4) { assertTrue(budget.take(100)) }
        assertFalse(budget.take(100), "a fifth stays still")
        budget.give(100)
        assertTrue(budget.take(100), "until one stops")
        assertEquals(4, budget.playingNow)
        val rate = PlaybackBudget(maxPlaying = 10, maxPixelsPerSecond = 1_000)
        assertTrue(rate.take(600))
        assertFalse(rate.take(500), "over the pixels a second together")
        assertTrue(rate.take(400))
        assertFalse(PlaybackBudget().take(0), "nothing counted, nothing played")
    }

    @Test fun manyVisibleAnimationsStayWithinTheTotal() {
        val budget = PlaybackBudget()
        val each = AnimationLimits.MAX_PIXELS_PER_SECOND
        val playing = (0 until 50).count { budget.take(each) }
        assertTrue(playing * each <= AnimationLimits.MAX_PLAYING_PIXELS_PER_SECOND)
        assertTrue(playing <= AnimationLimits.MAX_PLAYING)
        assertTrue(playing >= 1)
    }

    // ---- files, made by hand: a frame each, a byte of picture in it.

    private fun gif(frames: Int, colorTables: Boolean = false, delayCs: Int = 10): ByteArray {
        val out = ByteArrayOutputStream()
        out.write("GIF89a".toByteArray())
        // 1x1, global colour table of 2 entries when asked.
        out.write(byteArrayOf(1, 0, 1, 0, if (colorTables) 0x80.toByte() else 0, 0, 0))
        if (colorTables) out.write(ByteArray(6))
        // Netscape loop extension.
        out.write(byteArrayOf(0x21, 0xFF.toByte(), 11) + "NETSCAPE2.0".toByteArray() + byteArrayOf(3, 1, 0, 0, 0))
        repeat(frames) {
            out.write(byteArrayOf(0x21, 0xF9.toByte(), 4, 0, delayCs.toByte(), (delayCs shr 8).toByte(), 0, 0))
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
        repeat(frames) { body.write("ANMF".toByteArray() + le(17) + ByteArray(12) + byteArrayOf(100, 0, 0) + ByteArray(2) + byteArrayOf(0)) }
        val b = body.toByteArray()
        return "RIFF".toByteArray() + le(b.size) + b
    }

    private fun apng(frames: Int, declared: Int = frames, secondDeclared: Int? = null): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        fun chunk(type: String, data: ByteArray) = out.write(be(data.size) + type.toByteArray() + data + ByteArray(4))
        chunk("IHDR", ByteArray(13))
        chunk("acTL", be(declared) + be(0))
        secondDeclared?.let { chunk("acTL", be(it) + be(0)) }
        // delay 1/10 s.
        val fctl = ByteArray(20) + byteArrayOf(0, 1, 0, 10) + ByteArray(2)
        repeat(frames) { chunk("fcTL", fctl); chunk(if (it == 0) "IDAT" else "fdAT", ByteArray(4)) }
        chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }
}
