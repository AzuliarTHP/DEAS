import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../../i18n/I18nProvider';
import { librarySearchEvent } from '../../lib/wizards';
import { DarkWizards } from './DarkWizards';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true, convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

const qwen = { category: 'diffusion_models', name: 'qwen_image_2.1_turbo.safetensors', path: '/m/diffusion_models/qwen_image_2.1_turbo.safetensors', size: 1, info: null, family: 'qwen-image-2.1-turbo' };
const sdxl = { category: 'checkpoints', name: 'sdxl.safetensors', path: '/m/checkpoints/sdxl.safetensors', size: 1, info: null, family: 'sdxl' };
const lora = { category: 'loras', name: 'qwen-lora.safetensors', path: '/m/loras/qwen-lora.safetensors', size: 1, info: null, family: 'qwen-image-2.1' };
let models: unknown[];
let picks: string[];
const calls = (name: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === name).map(([, a]) => a as Record<string, unknown>);

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('deas.locale.v1', 'en');
  models = [qwen, sdxl, lora]; picks = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as Record<string, any>;
    if (command === 'native_models_scan') return models;
    if (command === 'native_analysis_pick') return picks.shift() ?? '/pics/street.png';
    if (command === 'native_media_describe') return a.paths.map((path: string) => ({ kind: 'file', name: path.split('/').pop(), path, media: /\.(png|jpe?g|webp)$/i.test(path) ? 'image' : null }));
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const ui = (props: Partial<Parameters<typeof DarkWizards>[0]> = {}) => {
  const onPrepare = vi.fn();
  const view = render(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} {...props}/></I18nProvider>);
  return { onPrepare, view };
};
async function choosePicture(width = 1920, height = 1080, slot: 'picture to change' | 'object to put in' = 'picture to change', name = 'street.png') {
  fireEvent.click(await screen.findByRole('button', { name: `Choose… ${slot}` }));
  const img = await screen.findByRole('img', { name });
  Object.defineProperties(img, { naturalWidth: { value: width }, naturalHeight: { value: height } });
  fireEvent.load(img);
  await screen.findByText(`${name} · ${width}×${height}`);
}
const type = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });

it('prefers the Qwen reference edit, keeps the picture aspect on the 32 px grid and prepares Generate without running', async () => {
  const { onPrepare } = ui();
  await choosePicture();
  const prepare = screen.getByRole('button', { name: 'Prepare in Generate' }) as HTMLButtonElement;
  expect(screen.getByRole('button', { name: 'Reference edit (Qwen Image 2.1)', pressed: true })).toBeTruthy();
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(qwen.path);
  type('With what', 'a blue bicycle');
  expect(prepare.disabled).toBe(true); // the reference template also needs "Replace what"
  type('Replace what', 'the red car');
  expect(prepare.disabled).toBe(false);
  fireEvent.click(prepare);
  expect(onPrepare).toHaveBeenCalledTimes(1);
  const handoff = onPrepare.mock.calls[0][0];
  expect(handoff).toMatchObject({ wizard: 'replace', strategy: 'reference', pipeline: 't2i', source: 'reference', model: { name: qwen.name, path: qwen.path },
    picture: { name: 'street.png', path: '/pics/street.png', src: 'asset:///pics/street.png' },
    positive: 'Replace the red car with a blue bicycle. Keep everything else in the picture unchanged.' });
  expect(handoff.edit).toBeUndefined();
  expect(handoff.size.width % 32).toBe(0); expect(handoff.size.height % 32).toBe(0);
  expect(Math.abs(handoff.size.width / handoff.size.height - 16 / 9)).toBeLessThan(0.05);
  expect(calls('native_models_scan')).toEqual([{ root: '/m' }]);
  // The wizard only scans, describes and asks for a file; it never prepares, uploads or submits jobs itself.
  expect(vi.mocked(invoke).mock.calls.map(([c]) => c).sort()).toEqual(['native_analysis_pick', 'native_media_describe', 'native_models_scan']);
});

it('falls back to inpaint with only the replacement text, and lets the user switch methods when both exist', async () => {
  models = [sdxl];
  const { onPrepare } = ui();
  await choosePicture(1000, 600);
  expect(screen.getByRole('button', { name: 'Reference edit (Qwen Image 2.1)' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Paint a mask (inpaint)', pressed: true })).toBeTruthy();
  expect(screen.getByText(/Paint over what should change/)).toBeTruthy();
  type('With what', 'a cat');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'inpaint', pipeline: 'i2i', source: 'edit', edit: 'inpaint', positive: 'a cat', model: { path: sdxl.path } });
  expect(onPrepare.mock.calls[0][0].size).toBeUndefined();
  cleanup(); models = [qwen, sdxl];
  ui();
  await screen.findByRole('button', { name: 'Reference edit (Qwen Image 2.1)', pressed: true });
  fireEvent.click(screen.getByRole('button', { name: 'Paint a mask (inpaint)' }));
  // Painting a mask keeps the Qwen model; other families are only offered below it.
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(qwen.path);
  expect([...(screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).options].map(o => o.value)).toEqual([qwen.path, sdxl.path]);
});

it('without a suitable model offers the Library search and a rescan instead of guessing', async () => {
  models = [{ ...sdxl, family: null }, lora];
  const asked = vi.fn(); window.addEventListener(librarySearchEvent, asked);
  ui();
  expect(await screen.findByText(/No suitable model is installed\. The wizard prefers Qwen Image 2\.1/)).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Find in Library' }));
  expect((asked.mock.calls[0][0] as CustomEvent).detail).toBe('Qwen Image 2.1');
  window.removeEventListener(librarySearchEvent, asked);
  models = [qwen];
  fireEvent.click(screen.getByRole('button', { name: 'Look again' }));
  await screen.findByRole('combobox', { name: 'Model' });
  expect(calls('native_models_scan').at(-1)).toEqual({ root: '/m', refresh: true });
  expect((screen.getByRole('button', { name: 'Prepare in Generate' }) as HTMLButtonElement).disabled).toBe(true); // no picture yet
});

it('takes a file copied in a file manager by Ctrl+V, refuses other files, and shows Generate\'s refusal of the current hand-over', async () => {
  const { view, onPrepare } = ui({ handoff: 2, outcome: { n: 1, error: 'old refusal' } });
  await screen.findByRole('combobox', { name: 'Model' });
  expect(screen.queryByText('old refusal')).toBeNull();
  expect((screen.getByRole('button', { name: 'Prepare in Generate' }) as HTMLButtonElement).disabled).toBe(true); // hand-over 2 still pending
  fireEvent.paste(document.body, { clipboardData: { files: [], getData: (type: string) => type === 'text/uri-list' ? 'file:///pics/My%20Cat.webp' : '' } });
  expect(await screen.findByRole('img', { name: 'My Cat.webp' })).toBeTruthy();
  fireEvent.paste(document.body, { clipboardData: { files: [], getData: (type: string) => type === 'text/plain' ? '/pics/clip.mp4' : '' } });
  expect(screen.getByRole('img', { name: 'My Cat.webp' })).toBeTruthy(); // a video path is not a wizard picture
  view.rerender(<I18nProvider><DarkWizards active roots={{ models: '/m', input: '/in' }} onPrepare={onPrepare} handoff={2} outcome={{ n: 2, error: 'Generate cannot use the model the wizard chose.' }}/></I18nProvider>);
  expect(screen.getByText('Generate cannot use the model the wizard chose.')).toBeTruthy();
  await waitFor(() => expect(calls('native_media_describe')).toEqual([{ paths: ['/pics/My Cat.webp'] }]));
});

it('uses an object picture A inside picture B: reference edit and masked edit on the same Qwen model, text only elsewhere', async () => {
  picks = ['/pics/street.png', '/pics/dog.png'];
  const { onPrepare } = ui();
  await choosePicture(1920, 1080);
  // After the picture to change, the object slot is highlighted for the next paste.
  expect(document.querySelector('[data-wizard-picture="object"]')!.classList.contains('is-active')).toBe(true);
  await choosePicture(800, 800, 'object to put in', 'dog.png');
  type('Replace what', 'the red car');
  expect(screen.getByText(/becomes image 1 and the object picture image 2/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' })); // "With what" is optional with an object picture
  expect(onPrepare.mock.calls[0][0]).toMatchObject({ strategy: 'reference', source: 'reference', references: [{ name: 'dog.png', path: '/pics/dog.png' }],
    positive: 'Replace the red car in image 1 with the main object from image 2. Keep everything else in image 1 unchanged and match its lighting and perspective.' });
  expect(onPrepare.mock.calls[0][0].picture.path).toBe('/pics/street.png');
  fireEvent.click(screen.getByRole('button', { name: 'Paint a mask (inpaint)' }));
  expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(qwen.path);
  expect(screen.getByText(/as image 1, with the object picture as image 2 for the same Qwen Image 2\.1 model/)).toBeTruthy();
  expect(screen.getByText(/This picture is 1920×1080\. Inpaint with this model needs both sides on a multiple of 32 px/)).toBeTruthy();
  type('With what', 'the dog');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  const masked = onPrepare.mock.calls[1][0];
  expect(masked).toMatchObject({ strategy: 'inpaint', source: 'edit', edit: 'inpaint', pipeline: 'i2i', model: { path: qwen.path } });
  expect(masked.references.map((r: { path: string }) => r.path)).toEqual(['/pics/street.png', '/pics/dog.png']);
  expect(masked.positive).toBe('Replace the masked area of image 1 (the red car) with the dog from image 2. Keep everything outside the mask unchanged and match the lighting and perspective of image 1.');
  expect(masked.size).toBeUndefined();
  // A model without a reference encoder uses only the text and says so.
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: sdxl.path } });
  expect(screen.getByText(/This model uses only the text/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare in Generate' }));
  expect(onPrepare.mock.calls[2][0]).toMatchObject({ positive: 'the dog', model: { path: sdxl.path } });
  expect(onPrepare.mock.calls[2][0].references).toBeUndefined();
  fireEvent.click(document.querySelector('[data-wizard-remove="object"]')!);
  expect(screen.queryByRole('img', { name: 'dog.png' })).toBeNull(); expect(screen.queryByText(/This model uses only the text/)).toBeNull();
});
