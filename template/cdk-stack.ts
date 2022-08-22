import * as cdk from "@aws-cdk/core";
import * as AmplifyHelpers from "@aws-amplify/cli-extensibility-helper";
import { AmplifyDependentResourcesAttributes } from "../../types/amplify-dependent-resources-ref";
import * as sns from "@aws-cdk/aws-sns";
import * as subs from "@aws-cdk/aws-sns-subscriptions";
import * as appsync from "@aws-cdk/aws-appsync";
import * as iam from "@aws-cdk/aws-iam";
import * as sfn from "@aws-cdk/aws-stepfunctions";
import * as tasks from "@aws-cdk/aws-stepfunctions-tasks";

const START_EXECUTION_REQUEST_TEMPLATE = (stateMachineArn: String) => {
  return `
  {
    "version": "2018-05-29",
    "method": "POST",
    "resourcePath": "/",
    "params": {
      "headers": {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target":"AWSStepFunctions.StartSyncExecution"
      },
      "body": {
        "stateMachineArn": "${stateMachineArn}",
        "input": "{ \\\"input\\\": \\\"$context.args.input\\\"}"
      }
    }
  }
`;
};

const RESPONSE_TEMPLATE = `
## Raise a GraphQL field error in case of a datasource invocation error
#if($ctx.error)
  $util.error($ctx.error.message, $ctx.error.type)
#end
## if the response status code is not 200, then return an error. Else return the body **
#if($ctx.result.statusCode == 200)
    ## If response is 200, return the body.
  $ctx.result.body
#else
    ## If response is not 200, append the response to error block.
    $utils.appendError($ctx.result.body, $ctx.result.statusCode)
#end
`;

export class cdkStack extends cdk.Stack {
  constructor(
    scope: cdk.Construct,
    id: string,
    props?: cdk.StackProps,
    amplifyResourceProps?: AmplifyHelpers.AmplifyResourceProps
  ) {
    super(scope, id, props);
    /* Do not remove - Amplify CLI automatically injects the current deployment environment in this input parameter */
    new cdk.CfnParameter(this, "env", {
      type: "String",
      description: "Current Amplify CLI env name",
    });

    const dependencies: AmplifyDependentResourcesAttributes =
      AmplifyHelpers.addResourceDependency(
        this,
        amplifyResourceProps.category,
        amplifyResourceProps.resourceName,
        [
          {
            category: "api",
            resourceName: "amplifysfn",
          },
        ]
      );

    const api = appsync.GraphqlApi.fromGraphqlApiAttributes(this, "API", {
      graphqlApiId: cdk.Fn.ref(dependencies.api.amplifysfn.GraphQLAPIIdOutput),
    });

    // TODO: dynamic Region
    const httpdatasource = api.addHttpDataSource(
      "ds",
      "https://sync-states.eu-central-1.amazonaws.com",
      {
        name: "HTTPDataSourceWithSFN",
        authorizationConfig: {
          signingRegion: "eu-central-1",
          signingServiceName: "states",
        },
      }
    );

    const customer_support_topic = new sns.Topic(
      this,
      "Customer support SNS topic"
    );

    // TODO: email dynamic?
    customer_support_topic.addSubscription(
      new subs.EmailSubscription("pbv+training@amazon.de")
    );

    const appsyncStepFunctionsRole = new iam.Role(
      this,
      "SyncStateMachineRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      }
    );

    // TODO: limit resources and actions
    appsyncStepFunctionsRole.addToPolicy(
      new iam.PolicyStatement({
        resources: ["*"],
        actions: ["states:StartSyncExecution", "states:StartExecution"],
      })
    );

    // TODO: dynamic Region
    const serviceRole = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("states.eu-central-1.amazonaws.com"),
    });

    const detect_sentiment_task = new tasks.CallAwsService(
      this,
      "Detect feedback sentiment",
      {
        service: "comprehend",
        action: "detectSentiment",
        iamResources: ["*"],
        iamAction: "comprehend:DetectSentiment",
        parameters: { "Text.$": "$.input", LanguageCode: "en" },
      }
    );

    const sentiment_choice = new sfn.Choice(
      this,
      "Positive or non-positive sentiment?"
    );

    const handleNonPositiveResult = new tasks.SnsPublish(
      this,
      "Notify customer support",
      {
        topic: customer_support_topic,
        message: sfn.TaskInput.fromObject({
          Message: "Negative feedback detected.",
          "Detected sentiment": sfn.JsonPath.stringAt("$.Sentiment"),
        }),
      }
    );

    const nonPositiveResult = new sfn.Pass(
      this,
      "Non-positive feedback received",
      {
        result: sfn.Result.fromObject({ Sentiment: "NEGATIVE" }),
      }
    );

    handleNonPositiveResult.next(nonPositiveResult);

    const positiveResult = new sfn.Pass(this, "Positive feedback received", {
      result: sfn.Result.fromObject({ Sentiment: "POSITIVE" }),
    });

    sentiment_choice.when(
      sfn.Condition.stringEquals("$.Sentiment", "POSITIVE"),
      positiveResult
    );
    sentiment_choice.otherwise(handleNonPositiveResult);

    const stateMachineDefinition = detect_sentiment_task.next(sentiment_choice);

    const stateMachine = new sfn.StateMachine(this, "SyncStateMachine", {
      definition: stateMachineDefinition,
      stateMachineType: sfn.StateMachineType.EXPRESS,
      role: serviceRole,
    });

    stateMachine.grant(
      httpdatasource.grantPrincipal,
      "states:StartSyncExecution"
    );

    httpdatasource.createResolver({
      typeName: "Mutation",
      fieldName: "executeStateMachine",
      requestMappingTemplate: appsync.MappingTemplate.fromString(
        START_EXECUTION_REQUEST_TEMPLATE(stateMachine.stateMachineArn)
      ),
      responseMappingTemplate:
        appsync.MappingTemplate.fromString(RESPONSE_TEMPLATE),
    });
  }
}
