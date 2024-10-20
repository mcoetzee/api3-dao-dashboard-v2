/**
 * When a proposal is passed, it can be used to execute the EVM script that was specified when the proposal was created.
 * The script can be a function call or multiple function calls. Proposals need to be executed by separate transaction
 * and the executor will pay the gas cost for the EVM script that is run.
 *
 * For now, we only support a single function call in the EVM script. The reasons are that it's enough for the most
 * cases, it's easier to encode it and we can create a simpler UI for end users.
 *
 * The EVM script is basically encoded "bytes" which contain the function(s) to be called and their parameters. We also
 * support ENS names when specifying them as function parameters. The conversion needs to take place before the script
 * is encoded. The encoding uses a predefined format (see the links below) and you can use "defaultAbiCoder" for
 * encoding the bytes value.
 *
 * @see execute function implementation:
 *      https://github.com/aragon/aragon-apps/blob/631048d54b9cc71058abb8bd7c17f6738755d950/apps/agent/contracts/Agent.sol#L70
 * @see EVM script layout:
 *      https://github.com/aragon/aragonOS/blob/f3ae59b00f73984e562df00129c925339cd069ff/contracts/evmscript/executors/CallsScript.sol#L26
 */
import { go, GoResult, goSync, fail, success } from '@api3/promise-utils';
import { BigNumber, providers, utils } from 'ethers';
import range from 'lodash/range';
import { DecodedEvmScript, Proposal, ProposalMetadata } from '../../../chain-data';
import { Api3Agent } from '../../../contracts';
import { convertToAddressOrThrow, tryConvertToEnsName } from './ens-name';
import { NewProposalFormData } from './types';

// Similar to https://web3js.readthedocs.io/en/v1.2.0/web3-eth-abi.html#encodefunctionsignature
export const encodeFunctionSignature = (functionFragment: string) => {
  return utils.hexDataSlice(utils.keccak256(utils.toUtf8Bytes(functionFragment)), 0, 4);
};

/**
 * Converts BigNumber(s) decoded by ethers to strings for presentational purposes.
 *
 * @param value decoded by ethers (array or single value)
 */
export const stringifyBigNumbersRecursively = (value: unknown): any => {
  if (BigNumber.isBigNumber(value)) return value.toString();
  else if (Array.isArray(value)) return value.map(stringifyBigNumbersRecursively);
  else return value;
};

// https://github.com/aragon/aragon-apps/blob/631048d54b9cc71058abb8bd7c17f6738755d950/apps/agent/contracts/Agent.sol#L70
const encodedExecuteSignature = encodeFunctionSignature('execute(address,uint256,bytes)');

export class EncodedEvmScriptError extends Error {
  constructor(
    public field:
      | keyof Pick<NewProposalFormData, 'parameters' | 'targetSignature' | 'targetValue' | 'targetAddress'>
      | 'generic',
    public value: string
  ) {
    super(`Invalid field value. Details: field=${field}, value=${value}`);
  }
}

/**
 * Validates the form data and encodes the EVM script.
 *
 * @see decodeEvmScript for details how the script is decoded
 *
 * @param provider a provider which is able to resolve ENS names
 * @param formData the proposal data to be encoded
 * @param api3Agent the addresses of the voting app agents
 */
export const goEncodeEvmScript = async (
  provider: providers.Provider,
  formData: NewProposalFormData,
  api3Agent: Api3Agent
): Promise<GoResult<string, EncodedEvmScriptError>> => {
  // Ensure that the form parameters form a valid JSON array
  const goJsonParams = goSync(() => {
    const json = JSON.parse(formData.parameters);
    if (!Array.isArray(json)) throw new Error('Parameters must be an array');
    return json as string[];
  });
  if (!goJsonParams.success) {
    return fail(new EncodedEvmScriptError('parameters', 'Make sure parameters is a valid JSON array'));
  }
  const targetParameters = goJsonParams.data;

  // Target contract signature must be a valid solidity function signature
  const goTargetSignature = goSync(() => utils.FunctionFragment.from(formData.targetSignature));
  if (!goTargetSignature.success) {
    return fail(new EncodedEvmScriptError('targetSignature', 'Please specify a valid contract signature'));
  }
  const targetSignature = formData.targetSignature;

  // Extract the parameters that were passed and check if the number of arguments is same as in the function signature
  const goExtractParameters = goSync(() => {
    // Extract the parameter types from the target function signature
    const parameterTypes = targetSignature
      .substring(targetSignature.indexOf('(') + 1, targetSignature.indexOf(')'))
      .split(',')
      // Function can have zero arguments, in that case we want the array to be empty
      .filter((s) => s.length > 0);

    if (parameterTypes.length !== targetParameters.length) {
      throw new Error();
    }

    return parameterTypes;
  });
  if (!goExtractParameters.success) {
    return fail(new EncodedEvmScriptError('parameters', 'Please specify the correct number of function arguments'));
  }
  const parameterTypes = goExtractParameters.data;

  // Resolve ENS names for parameter addresses and encode target parameters using defaultAbiCoder
  const goEncodeParameters = await go(async () => {
    const parameters = await Promise.all(
      range(parameterTypes.length).map(async (i) => {
        const param = targetParameters[i]!;
        if (parameterTypes[i] !== 'address') return param;

        return convertToAddressOrThrow(provider, param);
      })
    );
    // Encode the parameters using the parameter types
    return utils.defaultAbiCoder.encode(parameterTypes, parameters);
  });
  if (!goEncodeParameters.success) {
    return fail(
      new EncodedEvmScriptError(
        'parameters',
        // NOTE: Unfortunately, when checking for valid contract signature ethers will check only the formatting issues
        // and will not catch for example a typo "unit256" instead of "uint256". We will catch this here when we try to
        // encode the parameter types and values.
        'Ensure parameters match target contract signature'
      )
    );
  }
  const encodedTargetParameters = goEncodeParameters.data;

  // Ensure target address is a valid address or valid ENS name
  const goTargetAddress = await go(() => convertToAddressOrThrow(provider, formData.targetAddress));
  if (!goTargetAddress.success) {
    return fail(new EncodedEvmScriptError('targetAddress', 'Please specify a valid account address'));
  }
  const targetAddress = goTargetAddress.data;

  // Ensure value is a non-negative amount (in Wei)
  const goValue = goSync(() => {
    const parsed = BigNumber.from(formData.targetValue);
    if (parsed.lt(0)) throw new Error();
    return parsed;
  });
  if (!goValue.success) {
    return fail(new EncodedEvmScriptError('targetValue', 'Please enter a valid amount in Wei'));
  }
  const targetValue = goValue.data;

  // Build the EVM script according to the scheme
  const goBuildEvmScript = goSync(() => {
    // Build the call data that the EVMScript will use (and remove 0x prefix)
    const callData =
      encodedExecuteSignature +
      utils.defaultAbiCoder
        .encode(
          ['address', 'uint256', 'bytes'],
          [targetAddress, targetValue, encodeFunctionSignature(targetSignature) + encodedTargetParameters.substring(2)]
        )
        .substring(2);

    // Calculate the length of the call data in bytes
    const callDataLengthInBytes = utils.hexZeroPad(BigNumber.from(callData.substring(2).length / 2).toHexString(), 4);

    // See the EVMScript layout in:
    // https://github.com/aragon/aragonOS/blob/f3ae59b00f73984e562df00129c925339cd069ff/contracts/evmscript/executors/CallsScript.sol#L26
    //
    // Also, remove the 0x prefix in bytes
    const evmScript = [
      '0x00000001',
      api3Agent[formData.type].substring(2),
      callDataLengthInBytes.substring(2),
      callData.substring(2),
    ].join('');

    return evmScript;
  });
  if (!goBuildEvmScript.success) {
    return fail(
      new EncodedEvmScriptError(
        'generic',
        'Unable to encode the EVM script. Please check that all form fields are correct'
      )
    );
  }

  return success(goBuildEvmScript.data);
};

/**
 * Decodes the EVM script and returns the decoded fields. The decoding is basically formed by doing the inverse
 * operations performed in when encoding the proposal.
 *
 * @see goEncodeEvmScript for details on how the script is encoded
 *
 * @param provider a provider which is able to lookup ENS addresses
 * @param script the EVM script to be decoded
 * @param metadata proposal metadata to help decode the EVM script
 */
export const decodeEvmScript = async (
  provider: providers.Provider,
  script: string,
  metadata: ProposalMetadata
): Promise<DecodedEvmScript | null> => {
  const goResponse = await go(async () => {
    // See the EVMScript layout in:
    // https://github.com/aragon/aragonOS/blob/f3ae59b00f73984e562df00129c925339cd069ff/contracts/evmscript/executors/CallsScript.sol#L26
    const evmScriptPayload = utils.hexDataSlice(script, 4);
    const callData = utils.hexDataSlice(evmScriptPayload, 24);

    // Decode the parameters of the "execute" function:
    // https://github.com/aragon/aragon-apps/blob/631048d54b9cc71058abb8bd7c17f6738755d950/apps/agent/contracts/Agent.sol#L70
    const executionParameters = utils.defaultAbiCoder.decode(
      ['address', 'uint256', 'bytes'],
      utils.hexDataSlice(callData, 4)
    );
    const targetContractAddress = await tryConvertToEnsName(provider, executionParameters[0]);
    const value = executionParameters[1];

    // Decode the calldata of the last target function (last argument of the "execute" function) which are the decoded
    // EVM script parameters.
    const targetCallData = executionParameters[2];
    const parameterTypes = metadata.targetSignature
      .substring(metadata.targetSignature.indexOf('(') + 1, metadata.targetSignature.indexOf(')'))
      .split(',');
    const decodedParameters = utils.defaultAbiCoder.decode(parameterTypes, utils.hexDataSlice(targetCallData, 4));

    // Try to lookup ENS names for the addresses in the target calldata (EVM script parameters)
    const parameters = await Promise.all(
      range(parameterTypes.length).map(async (i) => {
        const param = decodedParameters[i]!;
        if (parameterTypes[i] !== 'address') return param;

        return tryConvertToEnsName(provider, param);
      })
    );

    return {
      targetAddress: targetContractAddress,
      value,
      parameters: stringifyBigNumbersRecursively(parameters),
    };
  });

  if (goResponse.success) return goResponse.data;
  else return null;
};

export async function isEvmScriptValid(
  provider: providers.Provider,
  api3Agent: Api3Agent,
  proposal: Pick<Proposal, 'type' | 'metadata' | 'decodedEvmScript' | 'script'>
) {
  const { metadata, decodedEvmScript } = proposal;
  if (!decodedEvmScript) {
    return false;
  }

  const result = await goEncodeEvmScript(
    provider,
    {
      type: proposal.type,
      targetSignature: metadata.targetSignature,
      description: metadata.description,
      title: metadata.title,
      parameters: JSON.stringify(decodedEvmScript.parameters),
      targetAddress: decodedEvmScript.targetAddress,
      targetValue: decodedEvmScript.value.toString(),
    },
    api3Agent
  );

  return result.success && result.data === proposal.script;
}
