package com.mikerosoft.threadbear.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikerosoft.threadbear.kit.MarkdownBlock
import kotlinx.coroutines.delay

/**
 * A fenced code block: a slim header strip (the language on the left, a
 * copy button on the right, a hairline under it) over the code, which
 * scrolls sideways. The same "header bar" design as the Mac's. A block
 * with no language still gets the strip, with just the copy button.
 */
@Composable
fun CodeBlockView(block: MarkdownBlock.Code, style: TextStyle) {
    val colors = MaterialTheme.colorScheme
    val signals = LocalSignals.current
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    // Which tap the "Copied" belongs to, so an older tap's timer doesn't put the icon back early.
    var copies by remember { mutableIntStateOf(0) }
    var copiedFor by remember { mutableIntStateOf(-1) }
    val copied = copiedFor == copies && copies > 0
    LaunchedEffect(copies) {
        if (copies == 0) return@LaunchedEffect
        delay(1500)
        copiedFor = -1
    }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(colors.surfaceContainerHigh)) {
        DisableSelection {
            Row(
                Modifier.fillMaxWidth().height(30.dp).background(colors.surfaceContainerHighest).padding(start = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val name = block.languageName
                if (name != null) {
                    Text(
                        name, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                }
                Spacer(Modifier.weight(1f))
                Row(
                    Modifier.fillMaxHeight().clickable(onClickLabel = "Copy code") {
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText(name ?: "Code", block.text))
                        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        copies += 1
                        copiedFor = copies
                    }.padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (copied) {
                        Icon(Line.Check, null, Modifier.size(14.dp), tint = signals.done)
                        Spacer(Modifier.width(5.dp))
                        Text("Copied", style = MaterialTheme.typography.labelMedium, color = signals.done, fontWeight = FontWeight.SemiBold)
                    } else {
                        Icon(Line.Copy, "Copy code", Modifier.size(15.dp), tint = colors.onSurfaceVariant)
                    }
                }
            }
        }
        HorizontalDivider(color = colors.outlineVariant)
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(10.dp)) {
            Text(block.text, style = style.copy(fontFamily = Mono, fontSize = 13.sp, lineHeight = 18.sp))
        }
    }
}
