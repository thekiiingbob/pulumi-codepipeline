const aws = require("@pulumi/aws");
const pulumi = require("@pulumi/pulumi");

// ====================================
// Example on how to use pulumis' secrets
// The next bit will set an encrypted secret value, stored in Pulumi.pulumi_codepipeline-dev.yaml
//
// pulumi config set --secret secretName secretValue
// pulumi config set myConfigVar configVarValue
//
// That stores the secret in that yaml file, and they can be pulled out below:
// ====================================

let config = new pulumi.Config("pulumi_codepipeline"); // pull's in config based on name in Pulumi.yaml

const mySecret = config.require("secretName");
const myConfigVar = config.require("myConfigVar");

// for demonstration purposes
console.log("mySecret is ", mySecret);
console.log("myConfigVar is ", myConfigVar);

// ====================================
// Create a bucket for storing artifacts
// ====================================

const bucket = new aws.s3.Bucket("MY_PIPELINE_BUCKET");

// ====================================
// Create SNS Topic, for the manual approval steps

// NOTE: We can subscribe emails by hand in the AWS Console
// without it mucking with our pulumi update commands
// ====================================

const topic = new aws.sns.Topic("MY_PIPELINE_SNS_TOPIC", {
  displayName: "pipesns"
}); // display name limit 10 characters

// ====================================
// Role for CodePipeline and CodeBuild
// ====================================

// Create policy
const policy = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: "sts:AssumeRole",
      Principal: {
        Service: "codebuild.amazonaws.com"
      },
      Effect: "Allow",
      Sid: ""
    }
  ]
};

// Base Role
const role = new aws.iam.Role("pl-role", {
  assumeRolePolicy: JSON.stringify(policy)
});

// Then attach these policies to the role
const buildAccess = new aws.iam.RolePolicyAttachment("codebuild-access", {
  role: role,
  policyArn: aws.iam.AWSCodeBuildDeveloperAccess
});

const cloudWatchAccess = new aws.iam.RolePolicyAttachment("cloudwatch-access", {
  role: role,
  policyArn: aws.iam.CloudWatchFullAccess
});

const s3Access = new aws.iam.RolePolicyAttachment("s3-access", {
  role: role,
  policyArn: aws.iam.AmazonS3FullAccess
});

const secretAccess = new aws.iam.RolePolicyAttachment("secret-access", {
  role: role,
  policyArn: aws.iam.AmazonSSMReadOnlyAccess
});

// ====================================
// CodeBuild Project
// ====================================

const project = new aws.codebuild.Project(
  "EXAMPLE_CODEBUILD_PROJECT",
  {
    buildTimeout: 10, // in minutes
    description: "Hey! This is my description!",
    serviceRole: role.arn,
    environment: {
      computeType: "BUILD_GENERAL1_SMALL",
      image: "aws/codebuild/docker:17.09.0", // other images are available
      type: "LINUX_CONTAINER",
      privilegedMode: true,
      environmentVariables: [
        {
          name: "MY_VARIABLE",
          type: "PLAINTEXT",
          value: "VALUE OF MY VARIABLE"
        }
      ]
    },
    artifacts: { type: "CODEPIPELINE" },
    source: {
      type: "CODEPIPELINE",
      buildspec: "./buildspec.yaml" // or wherever your buildspec lives. Note you could target different buildspecs for the same repo
    }
  },
  { dependsOn: [role] }
);

// ====================================
// The actual CodePipeline
// ====================================

const pipeline = new aws.codepipeline.Pipeline(
  "EXAMPLE_PIPELINE",
  {
    roleArn: role.arn,
    stages: [
      {
        name: "GitHub",
        actions: [
          {
            version: "1",
            name: "Source",
            category: "Source",
            owner: "ThirdParty",
            provider: "GitHub",
            runOrder: 1,
            configuration: {
              Branch: "master",
              OAuthToken: "GITHUB_OAUTH_TOKEN", // Probably best to use pulumi's secrets for this
              Owner: "NAME_OF_ACCOUNT",
              PollForSourceChanges: "false",
              Repo: "NAME_OF_REPO"
            },
            outputArtifacts: ["GitHubSource"]
          }
        ]
      },
      {
        name: "Test",
        actions: [
          {
            name: "MyTestStep",
            category: "Build",
            owner: "AWS",
            provider: "CodeBuild",
            version: "1",
            runOrder: 1,
            configuration: {
              ProjectName: project.name // Reference to the name of the CodeBuild Project we created above
            },
            outputArtifacts: ["TestResults"],
            inputArtifacts: ["GitHubSource"]
          },
          {
            name: "MyApprovalAction",
            category: "Approval",
            owner: "AWS",
            version: "1",
            provider: "Manual",
            inputArtifacts: [],
            outputArtifacts: [],
            configuration: {
              NotificationArn: topic.arn, // sns topic from above
              CustomData: "You can add a message here!"
            },
            runOrder: 2
          }
        ]
      }
    ],
    artifactStore: {
      type: "S3",
      location: bucket.bucket // bucket from amove
    },
    version: 1
  },
  { dependsOn: [project] }
);

// Export the name of your pipeline
exports.pipelineName = pipeline.name;
