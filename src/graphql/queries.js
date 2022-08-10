/* eslint-disable */
// this is an auto generated file. This will be overwritten

export const getFeedback = /* GraphQL */ `
  query GetFeedback($id: ID!) {
    getFeedback(id: $id) {
      id
      content
      createdAt
      updatedAt
    }
  }
`;
export const listFeedbacks = /* GraphQL */ `
  query ListFeedbacks(
    $filter: ModelFeedbackFilterInput
    $limit: Int
    $nextToken: String
  ) {
    listFeedbacks(filter: $filter, limit: $limit, nextToken: $nextToken) {
      items {
        id
        content
        createdAt
        updatedAt
      }
      nextToken
    }
  }
`;
