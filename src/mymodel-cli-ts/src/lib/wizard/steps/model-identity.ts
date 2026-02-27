/**
 * Wizard Step 2: Model identity (name + description).
 *
 * Uses @clack/prompts group() to batch both prompts together
 * with a single onCancel handler.
 */

import * as p from '@clack/prompts'
import {printStep} from '../../ui/output.js'

export interface ModelIdentityData {
  modelName: string
  modelDesc: string
}

export async function promptModelIdentity(totalSteps: number): Promise<ModelIdentityData> {
  printStep(2, totalSteps, 'Model Identity')

  const identity = await p.group(
    {
      modelName: () =>
        p.text({
          message: 'What should your model be called?',
          placeholder: 'MyModel',
          defaultValue: 'MyModel',
        }),
      modelDesc: () =>
        p.text({
          message: 'Description (optional):',
          placeholder: 'A smart routing layer for my LLMs',
          defaultValue: '',
        }),
    },
    {
      onCancel: () => {
        p.cancel('Setup cancelled.')
        process.exit(0)
      },
    },
  )

  return {
    modelName: identity.modelName.trim(),
    modelDesc: identity.modelDesc.trim(),
  }
}
