import { BigNumber } from 'ethers';
import { useCallback, useEffect } from 'react';
import { Proposals, ProposalType, updateImmutably, useChainData, VoterState } from '../../../chain-data';
import { Api3Voting, Convenience } from '../../../generated-contracts';
import { useApi3Voting, useConvenience, usePossibleChainDataUpdate } from '../../../contracts/hooks';
import { Proposal } from '../../../chain-data';
import { decodeMetadata } from '../encoding';
import zip from 'lodash/zip';
import { isGoSuccess, blockTimestampToDate, go, GO_RESULT_INDEX, GO_ERROR_INDEX } from '../../../utils';
import { chunk, difference, keyBy } from 'lodash';
import { openProposalIdsSelector, proposalDetailsSelector } from '../selectors';
import { getProposals, StartVoteProposal } from './common';

const VOTING_APP_IDS = {
  primary: 0,
  secondary: 1,
};

const CHUNKS_SIZE = 5;

export const useLoadAllProposals = () => {
  const { setChainData, userAccount } = useChainData();

  const api3Voting = useApi3Voting();
  const convenience = useConvenience();

  const loadProposals = useCallback(async () => {
    if (!api3Voting || !convenience) return;

    // TODO: use convenience contract and refactor this to load proposals by chunks
    const loadProposals = async () => {
      const { primary, secondary } = api3Voting;
      const startVoteFilter = primary.filters.StartVote(null, null, null);
      const primaryStartVotes = (await primary.queryFilter(startVoteFilter)).map((p) => p.args);
      const secondaryStartVotes = (await secondary.queryFilter(startVoteFilter)).map((p) => p.args);

      const primaryProposals = await getProposals(primary, userAccount, primaryStartVotes, 'primary');
      const secondaryProposals = await getProposals(secondary, userAccount, secondaryStartVotes, 'secondary');

      return {
        primary: keyBy(primaryProposals, 'voteId'),
        secondary: keyBy(secondaryProposals, 'voteId'),
      };
    };

    const goResponse = await go(loadProposals());
    if (isGoSuccess(goResponse)) {
      const proposals = goResponse[GO_RESULT_INDEX];

      setChainData('Load proposals', {
        proposals: {
          ...proposals,
        },
      });
    } else {
      // TODO: error handling
      console.error('Unable to load proposals', goResponse[GO_ERROR_INDEX]);
    }
  }, [api3Voting, convenience, userAccount, setChainData]);

  useEffect(() => {
    loadProposals();
  }, [loadProposals]);
};

export const useReloadActiveProposalsOnMinedBlock = () => {
  const { setChainData, userAccount, proposals } = useChainData();

  const api3Voting = useApi3Voting();
  const convenience = useConvenience();

  const reloadActiveProposals = useCallback(async () => {
    if (!api3Voting || !convenience) return;

    const loadProposals = async () => {
      const oldActiveProposalIds = openProposalIdsSelector(proposals);

      const updateState = (loadedChunk: Proposal[]) =>
        setChainData('(Re)load active proposals after loaded chunk', (state) =>
          updateImmutably(state, (immutableState) => {
            const proposals = immutableState.proposals;
            // If proposals are not loaded yet, they are still being fetched at the moment
            if (!proposals) return immutableState;

            loadedChunk.forEach((proposal) => {
              proposals.primary[proposal.voteId.toString()] = proposal;
            });
          })
        );

      const types = ['primary', 'secondary'] as const;

      for (const type of types) {
        const previousVoteIds = oldActiveProposalIds[type] ?? [];
        const currentVoteIds = await convenience.getOpenVoteIds(VOTING_APP_IDS[type]);

        // All of the new vote ids are new proposals created in the latest block and we need to fetch metadata for them
        const newVoteIds = difference(currentVoteIds, previousVoteIds);
        // TODO: Create a function to load proposals just by vote ids and does it in parallel
        const loadNewProposals = async () => {
          const newProposalEvents: StartVoteProposal[] = [];
          for (const id of newVoteIds) {
            const startVoteFilter = api3Voting[type].filters.StartVote(id, null, null);
            const events = (await api3Voting[type].queryFilter(startVoteFilter)).map((p) => p.args);
            newProposalEvents.push(events[0]); // There will be only one start event per voteId
          }

          // We don't expect many new proposal to be added, but we are loading as chunks just in case
          const chunks = chunk(newProposalEvents, CHUNKS_SIZE);
          for (const chunk of chunks) {
            updateState(await getProposals(api3Voting[type], userAccount, chunk, type));
          }
        };

        // All of the old proposals have metadata already loaded, we just need to update voting state
        const oldVoteIds = difference(currentVoteIds, previousVoteIds);
        const loadOldProposals = async () => {
          const voteIdsChunks = chunk(oldVoteIds, CHUNKS_SIZE); // TODO: sort by voteIds descending

          for (const chunkIds of voteIdsChunks) {
            const generalData = await convenience.getGeneralVoteData(VOTING_APP_IDS[type], chunkIds);
            const userData = await convenience.getUserVoteData(VOTING_APP_IDS[type], userAccount, chunkIds);

            const updatedProposals: Proposal[] = chunkIds.map((id, index) => {
              return {
                // TODO: We assume the proposal with the given id exists (and theoretically it might not)
                ...proposalDetailsSelector(proposals, type, id.toString())!,
                // NOTE: these are the the only fields that could have changed for active proposal
                yea: generalData.yea[index],
                nay: generalData.nay[index],
                executed: userData.executed[index],
              };
            });

            updateState(updatedProposals);
          }
        };

        loadNewProposals();
        loadOldProposals();
      }
    };

    const goResponse = await go(loadProposals());
    if (!isGoSuccess(goResponse)) {
      // TODO: error handling
      console.error('Unable to reload active proposals', goResponse[GO_ERROR_INDEX]);
    }
  }, [api3Voting, convenience, userAccount, setChainData, proposals]);

  // Ensure that the proposals are up to date with blockchain
  usePossibleChainDataUpdate(reloadActiveProposals);
};
