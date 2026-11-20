import { evidence, referenceModels, referenceNodes, refsEvidence } from './Workbench.testHarness';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Workbench } from './Workbench';
import { I18nProvider } from '../../i18n/I18nProvider';
import { checkRecipePrerequisites } from '../../lib/recipePrerequisites';
import { scanModels } from '../../lib/models';
import { runWorkbenchJob, uploadInput, uploadMask } from '../../lib/jobs';
import type { WizardHandoff } from '../../lib/wizards';

const picture = { name: 'street.png', path: '/pics/street.png', src: 'asset://localhost//pics/street.png' };
const reference: WizardHandoff = { n: 1, wizard: 'replace', strategy: 'reference', pipeline: 't2i', source: 'reference', model: { name: 'qwen.safetensors', path: '/m/q' }, picture,
  positive: 'Replace the red car with a blue bicycle. Keep everything else in the picture unchanged.', size: { width: 1216, height: 672 } };
const inpaint: WizardHandoff = { n: 1, wizard: 'replace', strategy: 'inpaint', pipeline: 'i2i', source: 'edit', edit: 'inpaint', model: { name: 'a.safetensors', path: '/m/a' }, picture, positive: 'a blue bicycle' };
const qwenEvidence = () => ({ ...refsEvidence, allowlist: { ...refsEvidence.allowlist, nodes: [...refsEvidence.allowlist.nodes, ...referenceNodes, 'UNETLoader', 'CLIPLoader', 'VAELoader'] } });
const prompt = () => (screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value;

test('a reference-edit hand-over selects the Qwen model, adds the picture as prompt reference, fixes the size and never runs', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  localStorage.setItem('deas.pref.studio.run.checkpoint', '"a.safetensors"');
  localStorage.setItem('deas.pref.studio.run.loras', JSON.stringify([{ name: 'style.safetensors', strength: 1, enabled: true }]));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={reference}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(1));
  expect((screen.getByRole('combobox', { name: 'Checkpoint' }) as HTMLSelectElement).value).toBe('qwen.safetensors');
  expect(prompt()).toBe(reference.positive);
  expect(document.querySelector('[data-reference-controls] img')?.getAttribute('alt')).toBe('street.png');
  expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1216');
  expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('672');
  expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('fixed');
  view.rerender(<I18nProvider><Workbench {...props} wizard={reference} planVisible/></I18nProvider>);
  const plan = JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
  expect(plan).toMatchObject({ checkpoint: 'qwen.safetensors', positivePrompt: reference.positive, width: 1216, height: 672, nativeImageReference: { method: 'qwen-image-2.1', images: ['/pics/street.png'] } });
  expect(plan.inputImage).toBeUndefined(); expect(plan.loras ?? []).toEqual([]);
  view.rerender(<I18nProvider><Workbench {...props} wizard={reference}/></I18nProvider>);
  // The same hand-over number is applied once; re-renders do not re-apply over later edits.
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'my own edit' } });
  view.rerender(<I18nProvider><Workbench {...props} wizard={reference}/></I18nProvider>);
  expect(prompt()).toBe('my own edit'); expect(applied).toHaveBeenCalledTimes(1);
  expect(runWorkbenchJob).not.toHaveBeenCalled(); expect(uploadInput).not.toHaveBeenCalled(); expect(uploadMask).not.toHaveBeenCalled();
});

test('an inpaint hand-over opens the picture in Inpaint with the prompt and keeps Run behind the mask gate', async () => {
  vi.mocked(scanModels).mockResolvedValue([{ category: 'checkpoints', name: 'a.safetensors', family: 'sdxl', path: '/m/a', size: 1, info: null }]);
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={inpaint}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(1));
  expect(prompt()).toBe('a blue bicycle');
  const img = screen.getByRole('img', { name: 'street.png' });
  Object.defineProperties(img, { naturalWidth: { value: 1024 }, naturalHeight: { value: 640 } }); fireEvent.load(img);
  expect(JSON.parse(localStorage.getItem('deas.pref.studio.run.edit')!)).toBe('inpaint');
  expect(screen.getByRole('button', { name: 'Add mask' })).toBeTruthy(); expect(screen.getByRole('button', { name: 'Mask 1' })).toBeTruthy();
  expect(document.querySelector('.wb-editor-host')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
  expect(runWorkbenchJob).not.toHaveBeenCalled(); expect(uploadInput).not.toHaveBeenCalled();
});

test('a hand-over Generate cannot honour is refused by number without touching the draft; Beginner refuses too', async () => {
  vi.mocked(scanModels).mockResolvedValue([{ category: 'checkpoints', name: 'a.safetensors', family: 'sdxl', path: '/m/a', size: 1, info: null }]);
  localStorage.setItem('deas.pref.studio.run.positive', JSON.stringify('kept'));
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('a.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...reference, n: 4 }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(4, expect.stringContaining('Generate cannot use the model')));
  expect(prompt()).toBe('kept');
  expect(screen.getAllByText(/Generate cannot use the model the wizard chose/).length).toBeGreaterThan(0);
  view.unmount();
  const beginner = vi.fn();
  render(<I18nProvider><Workbench endpoint={evidence.baseUrl} roots={{ models: '/m' }} beginner onWizardApplied={beginner} wizard={{ ...inpaint, n: 5 }}/></I18nProvider>);
  await waitFor(() => expect(beginner).toHaveBeenCalledWith(5, expect.stringContaining('Switch to Advanced')));
  expect(runWorkbenchJob).not.toHaveBeenCalled();
});

test('a masked Qwen hand-over keeps one model: picture to edit plus image 1/image 2 prompt references, and the grid gate stays visible', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  const object = { name: 'dog.png', path: '/pics/dog.png', src: 'asset://localhost//pics/dog.png' };
  const handoff: WizardHandoff = { ...inpaint, model: { name: 'qwen.safetensors', path: '/m/q' }, references: [picture, object],
    positive: 'Replace the masked area of image 1 (the red car) with the dog from image 2.' };
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('qwen.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(1));
  const load = (width: number, height: number) => { for (const img of screen.getAllByRole('img', { name: 'street.png' })) { Object.defineProperties(img, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } }); fireEvent.load(img); } };
  load(1024, 576);
  await waitFor(() => expect(document.querySelector('.wb-editor-host')).not.toBeNull());
  expect(screen.queryByText(/Resample this image to the selected model’s resolution grid/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Mask 1' })).toBeTruthy();
  view.rerender(<I18nProvider><Workbench {...props} wizard={handoff} planVisible/></I18nProvider>);
  const plan = JSON.parse(document.querySelector('[data-plan-intent]')!.textContent!);
  expect(plan).toMatchObject({ checkpoint: 'qwen.safetensors', width: 1024, height: 576, positivePrompt: handoff.positive, nativeImageReference: { method: 'qwen-image-2.1', images: ['/pics/street.png', '/pics/dog.png'] } });
  expect(runWorkbenchJob).not.toHaveBeenCalled(); expect(uploadInput).not.toHaveBeenCalled();
});

test('a masked Qwen hand-over of a picture off the 32 px grid shows Generate\'s resample gate instead of running', async () => {
  vi.mocked(scanModels).mockResolvedValue(referenceModels('qwen-image-2.1-turbo'));
  vi.mocked(checkRecipePrerequisites).mockResolvedValue(qwenEvidence());
  const applied = vi.fn(), props = { endpoint: evidence.baseUrl, roots: { models: '/m' }, onWizardApplied: applied };
  const view = render(<I18nProvider><Workbench {...props}/></I18nProvider>);
  await waitFor(() => expect(document.querySelector('[data-model-picker]')?.textContent).toContain('qwen.safetensors'));
  view.rerender(<I18nProvider><Workbench {...props} wizard={{ ...inpaint, model: { name: 'qwen.safetensors', path: '/m/q' }, references: [picture, { ...picture, name: 'dog.png', path: '/pics/dog.png' }] }}/></I18nProvider>);
  await waitFor(() => expect(applied).toHaveBeenCalledWith(1));
  for (const img of screen.getAllByRole('img', { name: 'street.png' })) { Object.defineProperties(img, { naturalWidth: { value: 1000 }, naturalHeight: { value: 600 } }); fireEvent.load(img); }
  expect(await screen.findByText(/Resample this image to the selected model’s resolution grid/)).toBeTruthy();
  expect(document.querySelector<HTMLButtonElement>('[data-run]')!.disabled).toBe(true);
  expect(runWorkbenchJob).not.toHaveBeenCalled();
});
