import React, { type FC } from 'react';
import { dashboard } from '@wix/dashboard';
import {
  Button,
  EmptyState,
  Image,
  Page,
  TextButton,
  WixDesignSystemProvider,
} from '@wix/design-system';
import '@wix/design-system/styles.global.css';
import * as Icons from '@wix/wix-ui-icons-common';
import wixLogo from './wix_logo.svg';

const Index: FC = () => {
  return (
    <WixDesignSystemProvider features={{ newColorsBranding: true }}>
      <Page>
        <Page.Header
          title="Dashboard Page"
          subtitle="Add management capabilities to your app."
          actionsBar={
            <Button
              onClick={() => {
                dashboard.openModal('b6a34a8c-1474-4b80-86bb-398e380589cb')}
              }
              prefixIcon={<Icons.GetStarted />}
            >
              Open Modal
            </Button>
          }
        />
        <Page.Content>
          <EmptyState
            image={
              <Image fit="contain" height="100px" src={wixLogo} transparent />
            }
            title="Start editing this dashboard page"
            subtitle="Learn how to work with dashboard pages and how to add functionality to them using Wix APIs."
            skin="page"
          >
            <TextButton
              as="a"
              href="https://dev.wix.com/docs/build-apps/develop-your-app/frameworks/wix-cli/supported-extensions/dashboard-extensions/dashboard-pages/add-dashboard-page-extensions-with-the-cli#add-dashboard-page-extensions-with-the-cli"
              target="_blank"
              prefixIcon={<Icons.ExternalLink />}
            >
              Dashboard pages documentation
            </TextButton>
          </EmptyState>
        </Page.Content>
      </Page>
    </WixDesignSystemProvider>
  );
};

export default Index;
