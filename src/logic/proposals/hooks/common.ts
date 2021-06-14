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

export interface StartVoteProposal {
  voteId: BigNumber;
  creator: string;
  metadata: string;
}

export const getProposals = async (
  api3Voting: Api3Voting,
  userAccount: string,
  startVoteProposals: StartVoteProposal[],
  type: ProposalType
): Promise<Proposal[]> => {
  const startVotesInfo = startVoteProposals.map((p) => ({
    voteId: p.voteId,
    creator: p.creator,
    metadata: decodeMetadata(p.metadata),
  }));

  const votingTime = await api3Voting.voteTime();
  const PCT_BASE = await api3Voting.PCT_BASE();
  const toPercent = (value: BigNumber) => value.mul(100).div(PCT_BASE);

  const getVoteCallsInfo = (await Promise.all(startVotesInfo.map(({ voteId }) => api3Voting.getVote(voteId)))).map(
    (p) => ({
      open: p.open,
      script: p.script,
      executed: p.executed,
      startDate: blockTimestampToDate(p.startDate),
      startDateRaw: p.startDate,
      supportRequired: toPercent(p.supportRequired),
      minAcceptQuorum: toPercent(p.minAcceptQuorum),
      yea: p.yea,
      nay: p.nay,
      votingPower: p.votingPower,
      deadline: blockTimestampToDate(p.startDate.add(votingTime)),
    })
  );

  const voterStatesInfo = await Promise.all(
    startVotesInfo.map(({ voteId }) => api3Voting.getVoterState(voteId, userAccount))
  );

  return zip(startVotesInfo, getVoteCallsInfo, voterStatesInfo).map(([startVote, getVote, voterState]) => ({
    ...startVote!,
    ...getVote!,
    voterState: voterState! as VoterState,
    type,
  }));
};
