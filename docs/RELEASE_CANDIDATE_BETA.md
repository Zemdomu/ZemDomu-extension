# ZemDomu Extension Release-Candidate Beta

This beta checks whether the ZemDomu VS Code Extension is useful and safe in
real HTML, React, and Vue projects before version 1.0.

## Before You Start

- Participation is voluntary. You can stop at any time.
- Work in a branch or disposable copy and review every suggested edit before
  keeping it.
- ZemDomu analyzes supported files locally and does not transmit source files,
  diagnostics, or usage telemetry.
- Do not share proprietary source, credentials, personal data, repository
  names, or unsanitized output logs. Use a minimal safe example when reporting
  a problem.
- Feedback may be summarized anonymously in release-readiness evidence. Use a
  participant code such as `B01`; do not include your name in the beta record.

By submitting feedback, you confirm that you understand these points and
consent to anonymous aggregation of the answers below.

## Install the Candidate

1. Open ZemDomu in the VS Code Extensions view.
2. Select the dropdown on **Install**, then choose
   **Install Pre-Release Version**.
3. Reload VS Code when prompted.
4. Confirm the ZemDomu version in the Extensions view.

The candidate supports VS Code 1.105.0 and later. See the
[user guide](USER_GUIDE.md) for settings, supported rules, privacy details, and
troubleshooting.

## Test One Real Repository

Use an HTML, JSX, TSX, React, or Vue repository you are authorized to test.
Keep other linters enabled if that reflects your normal setup, but distinguish
findings by their source in the Problems panel.

1. Record your participant code, platform, VS Code version, ZemDomu version,
   syntax, and approximate supported-file count.
2. Run **ZemDomu: Scan Workspace for Semantic Accessibility Issues**
   (`Ctrl+Alt+Z` on Windows/Linux or `Cmd+Alt+Z` on macOS).
3. Review every ZemDomu finding, or at least 20 if the scan reports more than
   20. For each reviewed finding, classify it as:
   - **Useful/correct**: identifies a real issue or useful review point.
   - **Disputed**: you are unsure or disagree but cannot establish that the
     markup is valid.
   - **False positive**: the reported source is valid or intentionally accepted.
4. Open at least one rule-documentation link from a ZemDomu diagnostic.
5. Where a quick fix is offered, apply it only in your test branch. Review the
   diff, replace any `TODO-ZMD` marker with an author-approved value, save, and
   scan again.
6. Stop immediately if you encounter a crash, data loss, an edit outside the
   selected target, or a quick fix that makes an unsupported semantic guess.
7. Rate overall usefulness from 1 (not useful) to 5 (very useful).

## Return This Feedback

Copy this block into a comment on the
[1.0 beta issue](https://github.com/Zemdomu/ZemDomu-extension/issues/39), or send
it privately to the beta coordinator if even sanitized public feedback would
identify your project:

```text
Consent to anonymous aggregation: yes/no
Participant code:
Test date:
Operating system:
VS Code version:
ZemDomu version:
Syntax: HTML / JSX / TSX / React / Vue
Approximate supported-file count:
Other accessibility linters enabled:
ZemDomu findings reviewed:
Useful/correct:
Disputed:
False positives:
Suspected false negatives:
Quick fixes reviewed:
Unsafe or incorrect quick fixes:
Crash or data loss: yes/no
Overall usefulness (1-5):
Sanitized notes:
```

For a reproducible defect, use the repository's guided
[bug and diagnostic report forms](https://github.com/Zemdomu/ZemDomu-extension/issues/new/choose).
Remove private code, credentials, personal data, and identifying paths first.
