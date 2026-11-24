import SwiftUI
import ThreadbearKit
import UIKit

/// A fenced code block in a reply, as the Mac draws it: a slim strip across
/// the top with the language on the left ("TypeScript" for ```ts, nothing
/// for a bare fence) and Copy on the right, then the code, scrolling
/// sideways rather than wrapping.
struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var copied = false
    /// Which tap the "Copied" belongs to, so an older tap's timer doesn't
    /// put the copy icon back early.
    @State private var copies = 0
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 1 / displayScale)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code).font(.system(.footnote, design: .monospaced)).padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var header: some View {
        HStack(spacing: 8) {
            if let language {
                Text(MarkdownBlock.languageName(language))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(action: copy) {
                HStack(spacing: 4) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                    if copied { Text("Copied") }
                }
                .font(.caption.weight(copied ? .semibold : .regular))
                .frame(minWidth: 44, minHeight: 30, alignment: .trailing)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(copied ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
            .sensoryFeedback(.impact(weight: .light), trigger: copies)
            .accessibilityLabel(copied ? "Copied" : "Copy the code")
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .frame(height: 30)
        // A shade apart from the code under it, darker in light mode and
        // lighter in dark.
        .background(Color(.tertiarySystemFill))
    }

    private func copy() {
        UIPasteboard.general.string = code
        copies += 1
        let tap = copies
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            if copies == tap { copied = false }
        }
    }
}
