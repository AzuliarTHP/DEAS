# Dark Wizards

**Studio → Dark Wizards** holds guided helpers for common jobs. You give a wizard a picture and a few words; it picks a fitting installed model, the pipeline, the prompt and the output size, and **prepares Generate**. Nothing runs in the wizard: Generate shows the prepared draft, the Run Plan shows exactly what would be submitted, and you press **Run** there. A wizard run is an ordinary Generate job in the ordinary queue.

The tab is available in the Advanced experience. Beginner keeps its own composer; a prepared draft sent while Beginner is active is refused with a note.

## Replace

Swaps a person, object or detail in a picture for something else — described in words, or taken from a second picture.

1. **Picture to change** (B) — drop a PNG, JPEG or WebP file on its area, paste one (Ctrl+V anywhere on the tab), or press its **Choose…**. A file copied in a file manager is used from its own location. A picture pasted as image data (for example copied from a browser) is first saved to the backend's Input folder, the same way the Media dock's paste does.
2. **Object to put in** (A, optional) — a picture of what should go into B: a person, a product, a piece of clothing. Paste and drop go to the highlighted area; after B is set, the object area is highlighted. Click an area to choose where the next paste goes; **Remove** clears it.
3. **Replace what** and **With what** — for example *the red car* and *a blue bicycle*. With an object picture, *With what* is optional and may name the object in it (*the dog*); without it the prompt says *the main object*.
4. **Method** — the wizard selects the first method with an installed model; you can switch when both are available. Both methods prefer the same Qwen Image 2.1 / 2.1 Turbo model, so switching keeps the selected model:
   - **Reference edit (Qwen Image 2.1)**: B becomes the first prompt reference (`image 1`) of a text-to-image edit in Generate's **References**, A the second (`image 2`). The prompt reads *Replace the red car with a blue bicycle. Keep everything else in the picture unchanged.*, or with A *Replace the red car in image 1 with the dog from image 2. Keep everything else in image 1 unchanged and match its lighting and perspective.* The output size keeps B's aspect ratio at the model's default pixel count, on the 32-pixel grid Qwen reference encoding needs (the first reference fixes the output geometry).
   - **Paint a mask (inpaint)**: Generate opens B in **Inpaint**. With a Qwen model and an object picture, B and A are also its prompt references (`image 1`, `image 2`) and the prompt asks to replace the masked area of image 1 with the object from image 2 — one model does both, no second model is involved. Paint over the area that should change, then press Run; Run stays disabled until a mask is painted. Inpaint keeps B's size, so B must already lie on the model's grid (32 px for Qwen with references); the wizard says when it does not, and Generate then blocks Run until the picture is resampled.
   - When no Qwen model is installed, **Paint a mask** falls back to a Flux.2, Z-Image, Flux.1 or SDXL model with *With what* as the prompt. These models cannot read the object picture; the wizard says so and uses only the text.
5. **Model** — the installed models that fit the method, in the wizard's preference order. Models whose family DEAS does not know are never offered.
5. **Prepare in Generate** — switches to Generate with the prepared draft. If Generate cannot use the chosen model (for example the file was moved), the wizard shows why and nothing changes in Generate.

Preparing selects the model like a click in the Models dock (its remembered settings return), clears that draft's LoRAs, replaces the picture to edit / prompt references and the positive prompt, and leaves the negative prompt, seed, sampler and post-processing as they are. Check the Run Plan before Run. Components the model needs (text encoder, VAE) are checked by Generate as usual.

### When no model fits

The wizard says which model it prefers and offers **Find in Library**, which opens the Library catalog filtered to that name. Downloads stay in the Library with its license and consent steps; the wizard never downloads anything. After installing, press **Look again**.

## What a wizard is

A wizard is a data entry in `src/wizards/builtin.json`: its input fields, whether it takes an object picture and, per method, the accepted model families in preference order, the families that can read the object picture, the Generate pipeline, whether the picture is a reference or the picture to edit, the edit mode and the prompt templates (`{field}` required, `{field|fallback}` optional). DEAS validates these entries (known families only, matching pipeline/source/mask) and ignores invalid ones. The wizard only reads the model index, describes the chosen file and asks Generate to prepare a draft; it does not upload, prepare or submit jobs.

## Not yet included

One-click Run from the wizard, SAM text-to-mask from *Replace what* for the inpaint method, Replace for videos, and the planned Mood, Movie Maker and Grid Generator wizards are tracked in the [plan](PLAN.md#ux-22--dark-wizards-tab--replace-priority-1-movie-maker-mood-grid-generator).
