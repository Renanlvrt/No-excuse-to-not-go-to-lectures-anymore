# Backup demo recording — what to say, what to capture

The lecture text below was run through the real `extract_flowchart()` with
our live Gemini key at 17:30. Verified output: **4 nodes, 3 edges, 7.4s**.

| Card | Mode | Category |
|---|---|---|
| Gradient Descent | `steps` (3) | process |
| Backpropagation | `steps` (3) | process |
| Learning Rate | `definition` | math |
| Vanishing Gradient Problem | `definition` | warning |

Two `steps` cards means **two ▶ Play animated walkthroughs**, and three
distinct categories means visibly different card colours including the red
`warning`. That's why this script and not another one.

## Before you hit record — pre-warm

Run the script once, then on **Gradient Descent**:

1. Click **Rigour** and let level 3 generate. It caches by concept slug, so
   it's instant and free every time after.
2. Click **🔊 Read it to me** on each level you plan to show. Audio caches to
   disk too.

Now clear the map and start clean. During the recording, everything you touch
is already cached — no generation latency, no quota risk.

## Read this aloud (~70s at lecture pace)

> Okay, so today we're looking at how a neural network actually learns.
>
> The core idea is gradient descent. You have a loss function that measures
> how wrong the model currently is, and gradient descent is the procedure
> that walks the parameters downhill on that loss surface, one step at a time.
>
> The size of each step is the learning rate, and this is where most people
> get burned. Too large and you overshoot the minimum and oscillate forever.
> Too small and training takes days.
>
> Now, to actually compute those gradients in a deep network, you use
> backpropagation. You do a forward pass to get the prediction, compute the
> loss at the output, then propagate the error backwards layer by layer using
> the chain rule, accumulating the gradient for every weight.
>
> And a warning: if you stack too many layers, those gradients get multiplied
> together repeatedly and shrink toward zero. That's the vanishing gradient
> problem, and it's why deep networks were basically untrainable before the
> mid-2000s.

## Shot list (45–60s of usable footage)

Record longer than you need and trim. Don't narrate — the pitch is spoken
live over this.

| # | What | Note |
|---|---|---|
| 1 | Click ▶ Start listening, begin reading | Show the transcript filling in |
| 2 | Wait for the first cards | **Expect ~7s**, not instant. Keep talking through it |
| 3 | Let all 4 cards land and the radial layout settle | The map arranging itself is the money shot |
| 4 | 🔍 Fit to view | |
| 5 | Click **Gradient Descent** | Panel opens |
| 6 | Click **Intuition** → **Mechanism** | Instant, no network. Linger a beat on each |
| 7 | Click **Rigour** | Pre-warmed, so instant |
| 8 | Click **🔊 Read it to me**, let 4s play | Pre-warmed |
| 9 | Say clearly: **"explain that simpler"** | Card drops to Intuition. If it no-ops, cut this shot — don't retry on camera |
| 10 | Click ▶ Play on the steps walkthrough | Animated stepper, one of the strongest visuals |
| 11 | Topbar **Whole map** → `1 · Intuition` | Every card re-levels at once. End on this |

## If the mic path fails while recording

Paste the lecture text into the type/paste box instead. Same pipeline, and
it's the path with the most verification behind it. The footage looks
identical from step 2 onward.
