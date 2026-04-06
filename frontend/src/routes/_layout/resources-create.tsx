import { createFileRoute, redirect } from "@tanstack/react-router"

import { UsersService } from "@/client"
import { ApplicationRequestPage } from "@/components/Applications/ApplicationRequestPage"

export const Route = createFileRoute("/_layout/resources-create")({
  component: ResourcesCreateRoute,
  beforeLoad: async () => {
    const user = await UsersService.readUserMe()
    if (user.role !== "student") {
      throw redirect({
        to: "/applications",
      })
    }
  },
  head: () => ({
    meta: [
      {
        title: "Create Resource - Campus Cloud",
      },
    ],
  }),
})

function ResourcesCreateRoute() {
  return <ApplicationRequestPage />
}
